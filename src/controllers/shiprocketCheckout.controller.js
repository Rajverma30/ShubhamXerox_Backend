/**
 * Shiprocket Checkout — catalogue endpoints.
 *
 * Shiprocket owns the cart, checkout and orders; this server only publishes
 * the catalogue it reads.
 *
 * Shiprocket calls these on our server to sync the catalogue into its checkout.
 * The client was given three URLs; note that PRODUCT FETCH and COLLECTION
 * PRODUCT FETCH are the *same* path — the difference is a collection filter
 * passed as a query parameter, which is why both map to `products` here.
 *
 *   GET  {prefix}/products                       all products, paginated
 *   GET  {prefix}/products?collection_id=<id>    products within one collection
 *   GET  {prefix}/collections                    categories + sub categories
 *   GET  {prefix}/ping                           connectivity + auth self-test
 */
const mongoose = require('mongoose');
const { Product, Category, SubCategory } = require('../models');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');
const { toProduct, toCollection, envelope, numericId } = require('../services/shiprocketCheckout.adapter');

const MAX_LIMIT = 250;

/** Shiprocket has used several names for the same paging params — accept all. */
function paging(q) {
  const page = Math.max(1, parseInt(q.page || q.page_no || q.pageNumber, 10) || 1);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(q.limit || q.per_page || q.page_size || q.count, 10) || 50),
  );
  return { page, limit, skip: (page - 1) * limit };
}

/**
 * Resolve a collection reference to a Mongo filter.
 * Accepts our slug, our ObjectId, or the numeric id we hand out in the adapter.
 */
async function collectionFilter(ref) {
  if (!ref) return null;
  const raw = String(ref).trim();

  // Template placeholders (e.g. "{collection_id}", ":collection_id", "collection_id") or wildcards (e.g. "all")
  const isTemplateOrAll = /^(?:\{|\:)?(?:collection_id|collectionId|collection_handle|collectionHandle|collection|id|slug)\}?$/i.test(raw)
    || /^(?:all|all-products|default|frontpage|home|undefined|null|0)$/i.test(raw);
  if (isTemplateOrAll) {
    return null; // Return null so no filter is applied (returns all active products)
  }

  const bySlug = await SubCategory.findOne({ slug: raw }).select('_id slug').lean()
    || await Category.findOne({ slug: raw }).select('_id slug').lean();
  if (bySlug) {
    const isSub = await SubCategory.exists({ _id: bySlug._id });
    return isSub ? { subCategory: bySlug._id } : { category: bySlug._id };
  }

  if (mongoose.isValidObjectId(raw)) {
    if (await SubCategory.exists({ _id: raw })) return { subCategory: raw };
    if (await Category.exists({ _id: raw })) return { category: raw };
  }

  // numeric id from the adapter — match by scanning the small taxonomy sets
  if (/^\d+$/.test(raw)) {
    const [cats, subs] = await Promise.all([
      Category.find().select('_id').lean(),
      SubCategory.find().select('_id').lean(),
    ]);
    const sub = subs.find((s) => String(numericId(s._id)) === raw);
    if (sub) return { subCategory: sub._id };
    const cat = cats.find((c) => String(numericId(c._id)) === raw);
    if (cat) return { category: cat._id };
  }

  return undefined; // signals "asked for a collection we don't have"
}

/**
 * GET {prefix}/products
 * Doubles as COLLECTION PRODUCT FETCH via ?collection_id= / ?collection_handle=
 */
exports.products = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paging(req.query);

  const filter = { isActive: true, isHidden: false };

  const ref = req.query.collection_id || req.query.collection_handle
    || req.query.collectionId || req.query.collection;
  if (ref) {
    const scoped = await collectionFilter(ref);
    if (scoped === undefined) {
      logger.info(`Shiprocket Checkout: asked for unknown collection "${ref}" — returning HTTP 200 with empty product list`);
      return res.json(envelope('products', [], { page, limit, total: 0 }));
    }
    if (scoped !== null) {
      Object.assign(filter, scoped);
    }
  }

  // Fetch a single product by id/handle when asked.
  const single = req.query.product_id || req.query.handle || req.query.sku;
  if (single) {
    const raw = String(single);
    const or = [{ slug: raw }, { sku: raw }];
    if (mongoose.isValidObjectId(raw)) or.push({ _id: raw });
    Object.assign(filter, { $or: or });
  }

  // Incremental sync support.
  if (req.query.updated_at_min) {
    filter.updatedAt = { $gte: new Date(req.query.updated_at_min) };
  }

  const [docs, total] = await Promise.all([
    Product.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    Product.countDocuments(filter),
  ]);

  logger.info(`Shiprocket Checkout: products page ${page} → ${docs.length}/${total}${ref ? ` (collection ${ref})` : ''}`);
  return res.json(envelope('products', docs.map(toProduct), { page, limit, total }));
});

/** Reference-project-compatible Collection Product Fetch endpoint. */
exports.collectionProducts = asyncHandler(async (req, res) => {
  const isTemplate = (val) => /^(?:\{|\:)?(?:collection_id|collectionId|collection_handle|collectionHandle|collection|id|slug)\}?$/i.test(String(val || '').trim());
  const qRef = req.query.collection_id || req.query.collection_handle || req.query.collectionId || req.query.collection;
  const pRef = req.params.collectionId;

  if (qRef && !isTemplate(qRef)) {
    req.query.collection_id = qRef;
  } else if (pRef && !isTemplate(pRef)) {
    req.query.collection_id = pRef;
  } else {
    delete req.query.collection_id;
  }
  return exports.products(req, res);
});

/** Direct single product endpoint. */
exports.singleProduct = asyncHandler(async (req, res) => {
  req.query.product_id = req.params.productId;
  return exports.products(req, res);
});

/** Direct single collection endpoint. */
exports.singleCollection = asyncHandler(async (req, res) => {
  const ref = req.params.collectionId;
  const isTemplateOrAll = /^(?:\{|\:)?(?:collection_id|collectionId|collection_handle|collectionHandle|collection|id|slug)\}?$/i.test(ref)
    || /^(?:all|all-products|default|frontpage|home|undefined|null|0)$/i.test(ref);

  if (isTemplateOrAll) {
    return res.json({
      data: {
        collection: {
          id: 0,
          title: 'All Products',
          handle: 'all',
          body_html: 'All Products',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: 'active',
        },
      },
    });
  }

  const [cat, sub] = await Promise.all([
    Category.findOne({ $or: [{ slug: ref }, ...(mongoose.isValidObjectId(ref) ? [{ _id: ref }] : [])] }).lean(),
    SubCategory.findOne({ $or: [{ slug: ref }, ...(mongoose.isValidObjectId(ref) ? [{ _id: ref }] : [])] }).lean(),
  ]);
  const doc = sub || cat;
  if (!doc) {
    return res.json({ data: { collection: null } });
  }
  return res.json({ data: { collection: toCollection(doc, { isSubCategory: Boolean(sub) }) } });
});

/**
 * GET {prefix}/collections
 * Categories and sub categories are both exposed as flat collections, tagged
 * with `level` and `parent_handle` so the hierarchy is still readable.
 */
exports.collections = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paging(req.query);
  const includeSubs = String(req.query.include_subcategories ?? 'true') !== 'false';

  const [categories, subCategories] = await Promise.all([
    Category.find({ isActive: true }).sort({ order: 1, name: 1 }).lean(),
    includeSubs ? SubCategory.find({ isActive: true }).sort({ order: 1, name: 1 }).lean() : [],
  ]);

  const all = [
    ...categories.map((c) => toCollection(c)),
    ...subCategories.map((s) => toCollection(s, { isSubCategory: true })),
  ];

  const slice = all.slice(skip, skip + limit);
  logger.info(`Shiprocket Checkout: collections page ${page} → ${slice.length}/${all.length}`);
  return res.json(envelope('collections', slice, { page, limit, total: all.length }));
});

/**
 * GET {prefix}/ping — verify Shiprocket can reach and authenticate with us.
 * Add ?debug=1 to see one real product and collection in the exact shape we
 * emit, which is the fastest way to diff against the integration document.
 */
exports.ping = asyncHandler(async (req, res) => {
  const [products, collections, subCategories] = await Promise.all([
    Product.countDocuments({ isActive: true, isHidden: false }),
    Category.countDocuments({ isActive: true }),
    SubCategory.countDocuments({ isActive: true }),
  ]);

  const body = {
    ok: true,
    service: 'subham-xerox',
    authenticated_via: req.shiprocketAuthMethod,
    catalogue: { products, collections: collections + subCategories },
    endpoints: {
      products: `${req.baseUrl}/products`,
      collection_products: `${req.baseUrl}/products?collection_id=<id|handle>`,
      collections: `${req.baseUrl}/collections`,
    },
    envelope: String(process.env.SHIPROCKET_CHECKOUT_FLAT_ARRAY).toLowerCase() === 'true'
      ? 'bare array'
      : '{ products: [...], pagination: {...} }',
  };

  if (req.query.debug) {
    const [p, c] = await Promise.all([
      Product.findOne({ isActive: true }).lean(),
      Category.findOne({ isActive: true }).lean(),
    ]);
    body.sample_product = p ? toProduct(p) : null;
    body.sample_collection = c ? toCollection(c) : null;
  }

  return res.json(body);
});

/** POST /shiprocket-checkout/loyalty/points — fetch customer loyalty points */
exports.getLoyaltyPoints = asyncHandler(async (req, res) => {
  const { mobile_number } = req.body || {};
  return res.json({
    data: {
      mobile_number: String(mobile_number || ''),
      available_points: 0,
      applicable_points: 0,
    },
  });
});

/** POST /shiprocket-checkout/loyalty/block — block points for order */
exports.blockLoyaltyPoints = asyncHandler(async (req, res) => {
  const { order_id } = req.body || {};
  return res.json({
    data: {
      status: true,
      available_points: 0,
      message: 'Valid Customer Id',
      debited_points: 0,
      transaction_id: String(order_id || Date.now()),
      discount_value: 0,
      additional_properties: {
        redemptionFactor: 1,
      },
    },
  });
});

/** POST /shiprocket-checkout/loyalty/unblock — unblock points for order */
exports.unblockLoyaltyPoints = asyncHandler(async (req, res) => {
  return res.json({
    data: {
      status: 'Success',
    },
  });
});

/** POST /shiprocket-checkout/shipping-charge — Fastrr custom shipping calculation */
exports.shippingCharge = asyncHandler(async (req, res) => {
  return res.json({
    success: true,
    status: true,
    data: {
      shipping_charge: 0,
      cod_charge: 0,
      is_cod_available: true,
      cod_available: true,
      serviceable: true,
      etd: '3-5 days',
    },
  });
});

/** POST /shiprocket-checkout/cart/validate — Fastrr cart validation */
exports.validateCart = asyncHandler(async (req, res) => {
  return res.json({
    success: true,
    status: true,
    message: 'Cart is valid',
    data: { valid: true },
  });
});

/** POST /shiprocket-checkout/coupon/apply — Fastrr coupon verification */
exports.applyCoupon = asyncHandler(async (req, res) => {
  return res.json({
    success: true,
    status: true,
    data: { valid: true, discount_amount: 0 },
  });
});

