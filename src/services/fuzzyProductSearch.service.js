const { Product } = require('../models');

const FIELDS = [
  'title', 'author', 'publisher', 'categoryName', 'subCategoryName',
  'language', 'tags', 'isbn', 'sku',
];
const CACHE_MS = 5 * 60 * 1000;
let cachedVocabulary;
let cachedAt = 0;
let vocabularyPromise;

function levenshteinWithin(left, right, maxDistance) {
  if (Math.abs(left.length - right.length) > maxDistance) return false;
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const next = [i];
    let rowMinimum = i;
    for (let j = 1; j <= right.length; j += 1) {
      const value = Math.min(
        next[j - 1] + 1,
        row[j] + 1,
        row[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      next.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maxDistance) return false;
    row = next;
  }
  return row[right.length] <= maxDistance;
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
    let tied = false;
    for (const candidate of vocabulary) {
      if (Math.abs(word.length - candidate.length) > maxDistance) continue;
      if (!levenshteinWithin(word, candidate, maxDistance)) continue;
      if (nearest) {
        tied = true;
        break;
      }
      nearest = candidate;
    }
    if (nearest && !tied) corrections.set(word, nearest);
  }

  if (!corrections.size) return original;
  return original.replace(/[\p{L}\p{N}]+/gu, (word) => corrections.get(word.toLocaleLowerCase()) || word);
}

module.exports = { correctSearchQuery, correctUsingVocabulary, levenshteinWithin };
