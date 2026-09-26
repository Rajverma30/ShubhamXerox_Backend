const slugify = require('slugify');

/** SEO-friendly slug. */
const toSlug = (str = '') => slugify(String(str), { lower: true, strict: true, trim: true });

/**
 * Slug that is unique within a collection.
 * Appends -2, -3 … until free. `ignoreId` lets an update keep its own slug.
 */
async function uniqueSlug(Model, source, ignoreId = null) {
  const base = toSlug(source) || 'item';
  let slug = base;
  let i = 1;
  /* eslint-disable no-await-in-loop */
  while (true) {
    const q = { slug };
    if (ignoreId) q._id = { $ne: ignoreId };
    const clash = await Model.exists(q);
    if (!clash) return slug;
    i += 1;
    slug = `${base}-${i}`;
  }
}

module.exports = { toSlug, uniqueSlug };
