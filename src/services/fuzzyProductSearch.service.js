const { Product } = require('../models');

const FIELDS = [
  'title', 'author', 'publisher', 'categoryName', 'subCategoryName',
  'language', 'tags', 'isbn', 'sku',
];
const CACHE_MS = 5 * 60 * 1000;
let cachedVocabulary;
let cachedAt = 0;
let vocabularyPromise;

function editDistanceWithin(left, right, maxDistance) {
  if (Math.abs(left.length - right.length) > maxDistance) return Infinity;
  const matrix = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j;

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1);
      }
    }
  }
  const distance = matrix[left.length][right.length];
  return distance <= maxDistance ? distance : Infinity;
}

async function getVocabulary() {
  if (cachedVocabulary && Date.now() - cachedAt < CACHE_MS) return cachedVocabulary;
  if (vocabularyPromise) return vocabularyPromise;

  vocabularyPromise = Promise.all(FIELDS.map((field) =>
    Product.distinct(field, { isActive: true, isHidden: false }),
  )).then((values) => {
    const vocabulary = new Set();
    for (const value of values.flat(Infinity)) {
      const words = String(value || '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
      for (const word of words) {
        if (word.length >= 4 && word.length <= 32) vocabulary.add(word);
      }
    }
    cachedVocabulary = vocabulary;
    cachedAt = Date.now();
    return vocabulary;
  }).finally(() => {
    vocabularyPromise = null;
  });
  return vocabularyPromise;
}

async function correctSearchQuery(query) {
  const original = String(query || '').trim();
  if (!original) return original;

  try {
    return correctUsingVocabulary(original, await getVocabulary());
  } catch {
    return original;
  }
}

function correctUsingVocabulary(query, vocabulary) {
  const original = String(query || '').trim();
  const words = original.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const corrections = new Map();

  for (const word of words) {
    if (word.length < 4 || vocabulary.has(word)) continue;
    const maxDistance = word.length >= 7 ? 2 : 1;
    let nearest = null;
    let nearestDistance = Infinity;
    let tied = false;
    for (const candidate of vocabulary) {
      if (Math.abs(word.length - candidate.length) > maxDistance) continue;
      const distance = editDistanceWithin(word, candidate, maxDistance);
      if (distance < nearestDistance) {
        nearest = candidate;
        nearestDistance = distance;
        tied = false;
      } else if (distance === nearestDistance && Number.isFinite(distance)) {
        tied = true;
      }
    }
    if (nearest && !tied) corrections.set(word, nearest);
  }

  if (!corrections.size) return original;
  return original.replace(/[\p{L}\p{N}]+/gu, (word) => corrections.get(word.toLocaleLowerCase()) || word);
}

module.exports = { correctSearchQuery, correctUsingVocabulary, editDistanceWithin };
