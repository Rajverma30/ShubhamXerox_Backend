/**
 * Translates storefront query strings into a Mongoose filter + sort.
 * Supports: search, category, subcategory, type, price range, author,
 * language, publisher, availability, min discount, rating, tags, flags.
 */
const SORTS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  'price-asc': { price: 1 },
  'price-desc': { price: -1 },
  'a-z': { title: 1 },
  'z-a': { title: -1 },
  'best-selling': { soldCount: -1 },
  rating: { 'rating.average': -1 },
  discount: { discountPercent: -1 },
  popular: { views: -1 },
  relevance: { soldCount: -1, views: -1, createdAt: -1 },
};

function buildTokenSearchFilter(search, fields) {
  const tokens = String(search || '').trim().split(/\s+/).filter(Boolean);
  return {
    $and: tokens.map((token) => {
      const rx = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      return { $or: fields.map((field) => ({ [field]: rx })) };
    }),
  };
}

function buildProductQuery(q = {}) {
  const filter = { isActive: true, isHidden: false };
  const meta = {};

  if (q.search && String(q.search).trim()) {
    Object.assign(filter, buildTokenSearchFilter(q.search, [
      'title', 'author', 'publisher', 'categoryName', 'subCategoryName',
      'language', 'tags', 'isbn', 'sku', 'description',
    ]));
    meta.textSearch = true;
  }
  if (q.type) filter.type = { $in: String(q.type).split(',') };
  if (q.category) filter.categorySlug = { $in: String(q.category).split(',') };
  if (q.subcategory) filter.subCategorySlug = { $in: String(q.subcategory).split(',') };
  if (q.author) filter.author = { $in: String(q.author).split(',') };
  if (q.language) filter.language = { $in: String(q.language).split(',') };
  if (q.publisher) filter.publisher = { $in: String(q.publisher).split(',') };
  if (q.tags) filter.tags = { $in: String(q.tags).split(',') };

  const min = Number(q.minPrice);
  const max = Number(q.maxPrice);
  if (!Number.isNaN(min) || !Number.isNaN(max)) {
    filter.price = {};
    if (!Number.isNaN(min)) filter.price.$gte = min;
    if (!Number.isNaN(max)) filter.price.$lte = max;
  }

  if (q.minDiscount) filter.discountPercent = { $gte: Number(q.minDiscount) };
  if (q.minRating) filter['rating.average'] = { $gte: Number(q.minRating) };

  if (q.availability === 'in-stock') filter.stock = { $gt: 0 };
  if (q.availability === 'out-of-stock') filter.stock = { $lte: 0 };

  ['isFeatured', 'isTrending', 'isBestSeller', 'isLatest', 'isNewArrival', 'hasFreeEbook'].forEach((flag) => {
    if (q[flag] !== undefined) filter[flag] = String(q[flag]) === 'true';
  });

  const sortKey = q.sort || (meta.textSearch ? 'relevance' : 'newest');
  const sort = SORTS[sortKey] || SORTS.newest;

  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(60, Math.max(1, parseInt(q.limit, 10) || 20));

  return { filter, sort, page, limit, skip: (page - 1) * limit, meta };
}

module.exports = { buildProductQuery, buildTokenSearchFilter, SORTS };
