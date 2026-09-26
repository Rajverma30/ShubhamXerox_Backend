/**
 * Admin dashboard aggregates.
 *
 * Orders, revenue and customers live in the Shiprocket Checkout dashboard —
 * this store never persists them — so the cards here cover the catalogue,
 * traffic and the content queues the admin actually owns.
 */
const { Product, Category, SubCategory, Visitor, Contact, Newsletter, Review, SearchHistory } = require('../models');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

/** GET /api/admin/dashboard */
exports.stats = asyncHandler(async (req, res) => {
  const range = Math.min(365, Number(req.query.days) || 30);
  const since = daysAgo(range);

  const [
    productCounts, categoryCount, subCategoryCount, visitorAgg, visitorSeries,
    topViewed, lowStock, recentProducts, pendingReviews, unreadContacts,
    newsletterCount, noResultSearches, topSearches,
  ] = await Promise.all([
    Product.aggregate([{ $group: { _id: '$type', count: { $sum: 1 } } }]),
    Category.countDocuments(),
    SubCategory.countDocuments(),
    Visitor.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: null, visitors: { $sum: 1 }, pageViews: { $sum: '$pageViews' } } },
    ]),
    Visitor.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$day', visitors: { $sum: 1 }, pageViews: { $sum: '$pageViews' } } },
      { $sort: { _id: 1 } },
    ]),
    Product.find({ isActive: true }).sort({ views: -1 }).limit(8)
      .select('title slug images views finalPrice stock').lean(),
    Product.find({ $expr: { $lte: ['$stock', '$lowStockThreshold'] }, type: { $ne: 'ebook' } })
      .sort({ stock: 1 }).limit(8).select('title slug stock lowStockThreshold images').lean(),
    Product.find().sort({ createdAt: -1 }).limit(6)
      .select('title slug images finalPrice createdAt isActive').lean(),
    Review.countDocuments({ isApproved: false }),
    Contact.countDocuments({ status: 'new' }),
    Newsletter.countDocuments({ isSubscribed: true }),
    SearchHistory.find({ hasNoResults: true }).sort({ count: -1 }).limit(8).select('term count').lean(),
    SearchHistory.find({ hasNoResults: false }).sort({ count: -1 }).limit(8).select('term count').lean(),
  ]);

  const byType = productCounts.reduce((a, c) => ({ ...a, [c._id]: c.count }), {});

  // Fill gaps so the traffic chart has no holes.
  const series = [];
  for (let i = range - 1; i >= 0; i -= 1) {
    const key = daysAgo(i).toISOString().slice(0, 10);
    const found = visitorSeries.find((v) => v._id === key);
    series.push({ date: key, visitors: found?.visitors || 0, pageViews: found?.pageViews || 0 });
  }

  return ok(res, {
    range,
    cards: {
      visitors: visitorAgg[0]?.visitors || 0,
      pageViews: visitorAgg[0]?.pageViews || 0,
      products: Object.values(byType).reduce((a, b) => a + b, 0),
      books: (byType.book || 0) + (byType['book+ebook'] || 0),
      ebooks: (byType.ebook || 0) + (byType['book+ebook'] || 0),
      stationery: byType.stationery || 0,
      categories: categoryCount,
      subCategories: subCategoryCount,
      newsletter: newsletterCount,
      pendingReviews,
      unreadContacts,
      outOfStock: lowStock.filter((p) => p.stock === 0).length,
    },
    charts: { traffic: series, productTypes: productCounts },
    topViewed,
    lowStock,
    recentProducts,
    noResultSearches,
    topSearches,
  });
});

/** POST /api/track — anonymous pageview beacon from the storefront. */
exports.track = asyncHandler(async (req, res) => {
  await Visitor.track({
    guestId: req.body.guestId,
    path: req.body.path,
    referrer: req.body.referrer,
    userAgent: req.headers['user-agent'],
  });
  return ok(res, { tracked: true });
});
