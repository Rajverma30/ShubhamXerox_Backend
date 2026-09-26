/**
 * Products (books, ebooks, stationery, book + free ebook).
 *
 * Highlight: `syncMedia()` implements the PDF rule from the spec —
 * if the admin uploads images, those win; otherwise the first N pages of the
 * uploaded PDF are rasterised and used as the gallery.
 */
const fs = require('fs/promises');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { Product, Category, SubCategory, Review, SearchHistory } = require('../models');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/response');
const { uniqueSlug } = require('../utils/slug');
const { cleanRichText, cleanText } = require('../utils/sanitize');
const { buildProductQuery } = require('../utils/queryFeatures');
const imageService = require('../services/image.service');
const pdfService = require('../services/pdf.service');
const logger = require('../utils/logger');
const shiprocketCatalogueSync = require('../services/shiprocketCatalogSync.service');

const CARD_FIELDS =
  'title slug sku type author price salePrice discountPercent finalPrice stock images rating soldCount ' +
  'categorySlug subCategorySlug categoryName subCategoryName hasFreeEbook isFeatured isTrending isBestSeller ' +
  'isNewArrival language publisher createdAt allowBackorder';

/* ───────────────────────────── helpers ───────────────────────────── */

const bool = (v) => v === true || String(v) === 'true';

/**
 * Fields the server owns. The admin form GETs the whole product and PUTs it
 * back, so these come round-tripped from the client — and because the form is
 * multipart/form-data, every nested object arrives as a STRING. Assigning
 * rating="{\"average\":0,\"count\":0}" to an object path is what produced:
 *
 *   Validation failed
 *   rating: Cast to Object failed for value "{"average":0,"count":0}" (type string)
 *
 * None of these should ever be settable by a form anyway — they are derived
 * from reviews, orders, the pre-save hook, or syncMedia(). Drop them.
 */
const SERVER_OWNED = [
  '_id', 'id', '__v', 'createdAt', 'updatedAt',
  'rating',            // maintained from the Review collection
  'views', 'soldCount', 'wishlistCount',
  'finalPrice',        // recomputed by the pre-save hook
  'images', 'imagesFromPdf', 'ebook', 'sourcePdf', 'hasFreeEbook', // syncMedia() owns these
  'inStock', 'isLowStock', 'isShippable', // virtuals
];

function parseProductBody(body) {
  const out = { ...body };

  SERVER_OWNED.forEach((k) => delete out[k]);

  ['highlights', 'tags', 'specifications', 'seo', 'dimensions', 'relatedProducts', 'ebookSettings', 'keepImages']
    .forEach((k) => {
      const v = out[k];
      if (typeof v !== 'string') return;
      const t = v.trim();
      if (!t.startsWith('[') && !t.startsWith('{')) return;
      // Malformed JSON from the form should be a clear 400, not a raw 500.
      try { out[k] = JSON.parse(t); } catch { throw ApiError.badRequest(`Invalid JSON in field "${k}"`); }
    });

  if (typeof out.tags === 'string') out.tags = out.tags.split(',').map((t) => t.trim()).filter(Boolean);
  if (typeof out.highlights === 'string') out.highlights = out.highlights.split('\n').map((t) => t.trim()).filter(Boolean);

  if (out.description) out.description = cleanRichText(out.description);
  if (out.shortDescription) out.shortDescription = cleanText(out.shortDescription);
  if (out.title) out.title = cleanText(out.title);

  ['price', 'salePrice', 'discountPercent', 'stock', 'pages', 'weight', 'taxPercent', 'lowStockThreshold', 'order', 'publishYear']
    .forEach((k) => { if (out[k] !== undefined && out[k] !== '') out[k] = Number(out[k]); else if (out[k] === '') delete out[k]; });

  if (out.stock !== undefined && out.stock < 3) out.stock = 3;

  ['isFeatured', 'isTrending', 'isBestSeller', 'isLatest', 'isNewArrival', 'isActive', 'isHidden', 'allowBackorder']
    .forEach((k) => { if (out[k] !== undefined) out[k] = bool(out[k]); });

  delete out.slug_;
  return out;
}

/**
 * Applies the image / PDF rules.
 * @param {Object} doc     product document (new or existing)
 * @param {Object} files   multer fields { images, pdf, ebook }
 * @param {Array}  keep    image urls the admin wants to keep (update flow)
 * @param {Object} settings ebook toggles sent as `ebookSettings` by the admin
 */
async function syncMedia(doc, files = {}, keep = null, settings = null) {
  const uploadedImages = files.images || [];
  const pdfFile = files.pdf?.[0];
  const ebookFile = files.ebook?.[0];

  // 1. Manual images always take precedence.
  let manual = [];
  if (uploadedImages.length) {
    manual = await imageService.processMany(uploadedImages, { folder: 'products', alt: doc.title });
  }

  // Preserve previously kept images on update.
  const existing = Array.isArray(keep)
    ? (doc.images || []).filter((i) => keep.includes(i.url))
    : (doc.images || []).filter((i) => i.source !== 'pdf');

  // 2. Store the source PDF (if any) and remember its page count.
  let pdfMeta = null;
  if (pdfFile) {
    pdfMeta = await pdfService.storePdf(pdfFile.path, { folder: 'pdf' });
    doc.sourcePdf = {
      url: pdfMeta.url,
      path: pdfMeta.path,
      filename: pdfMeta.filename,
      sizeBytes: pdfMeta.sizeBytes,
      pageCount: pdfMeta.pageCount,
    };
  }

  // 3. Free ebook PDF.
  //    `settings` are the isFree / allowPreview / previewPages toggles. They
  //    arrive as `ebookSettings` because multer owns the `ebook` field name.
  if (settings && (doc.ebook?.fileUrl || ebookFile)) {
    doc.ebook = {
      ...(doc.ebook?.toObject?.() || doc.ebook || {}),
      ...(settings.isFree !== undefined ? { isFree: settings.isFree === true || settings.isFree === 'true' } : {}),
      ...(settings.allowPreview !== undefined
        ? { allowPreview: settings.allowPreview === true || settings.allowPreview === 'true' }
        : {}),
      ...(settings.previewPages ? { previewPages: Number(settings.previewPages) } : {}),
    };
  }

  if (ebookFile) {
    const stored = await pdfService.storePdf(ebookFile.path, { folder: 'ebooks' });
    doc.ebook = {
      ...(doc.ebook?.toObject?.() || doc.ebook || {}),
      fileUrl: stored.url,
      filePath: stored.path,
      filename: stored.filename,
      sizeBytes: stored.sizeBytes,
      pageCount: stored.pageCount,
      isFree: doc.ebook?.isFree !== false,
      allowPreview: doc.ebook?.allowPreview !== false,
      previewPages: doc.ebook?.previewPages || pdfService.PREVIEW_PAGES,
      downloadCount: doc.ebook?.downloadCount || 0,
    };
  }

  const combined = [...existing, ...manual];

  // 4. THE RULE: no manual/kept images? generate them from the PDF.
  if (!combined.length) {
    const sourcePath = doc.sourcePdf?.path || doc.ebook?.filePath;
    if (sourcePath) {
      try {
        const pagesToExtract = Number(settings?.pdfPageCount || settings?.previewPages) || pdfService.PREVIEW_PAGES;
        const pages = await pdfService.extractPreviewImages(sourcePath, {
          pages: pagesToExtract,
          folder: 'products',
          altBase: doc.title,
        });
        if (pages.length) {
          doc.images = pages;
          doc.imagesFromPdf = true;
          return;
        }
      } catch (err) {
        logger.warn(`PDF image extraction failed for "${doc.title}":`, err.message);
      }
    }
    doc.images = [];
    doc.imagesFromPdf = false;
    return;
  }

  doc.images = combined;
  doc.imagesFromPdf = combined.every((i) => i.source === 'pdf');
}

/** Copies denormalised taxonomy names/slugs onto the product. */
async function syncTaxonomy(body) {
  if (body.category) {
    const cat = await Category.findById(body.category).lean();
    if (!cat) throw ApiError.badRequest('Category not found');
    body.categorySlug = cat.slug;
    body.categoryName = cat.name;
  }
  if (body.subCategory) {
    const sub = await SubCategory.findById(body.subCategory).lean();
    if (!sub) throw ApiError.badRequest('Sub category not found');
    body.subCategorySlug = sub.slug;
    body.subCategoryName = sub.name;
  } else if (body.subCategory === '') {
    body.subCategory = undefined;
    body.subCategorySlug = undefined;
    body.subCategoryName = undefined;
  }
}

/* ───────────────────────────── public ───────────────────────────── */

/** GET /api/products — the workhorse list endpoint (filters, sort, paging). */
exports.list = asyncHandler(async (req, res) => {
  const { filter, sort, page, limit, skip } = buildProductQuery(req.query);

  const projection = {};
  const [items, total] = await Promise.all([
    Product.find(filter, projection).select(CARD_FIELDS).sort(sort).skip(skip).limit(limit).lean(),
    Product.countDocuments(filter),
  ]);

  if (req.query.search) SearchHistory.record(req.query.search, total).catch(() => {});
  return paginated(res, items, { page, limit, total });
});

/** GET /api/products/facets — filter sidebar options for the current scope. */
exports.facets = asyncHandler(async (req, res) => {
  const match = { isActive: true, isHidden: false };
  if (req.query.category) match.categorySlug = req.query.category;
  if (req.query.subcategory) match.subCategorySlug = req.query.subcategory;

  const [agg] = await Product.aggregate([
    { $match: match },
    {
      $facet: {
        authors: [{ $match: { author: { $nin: ['', null] } } }, { $group: { _id: '$author', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 40 }],
        languages: [{ $group: { _id: '$language', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
        publishers: [{ $match: { publisher: { $nin: ['', null] } } }, { $group: { _id: '$publisher', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 30 }],
        types: [{ $group: { _id: '$type', count: { $sum: 1 } } }],
        subCategories: [{ $match: { subCategorySlug: { $nin: ['', null] } } }, { $group: { _id: { slug: '$subCategorySlug', name: '$subCategoryName' }, count: { $sum: 1 } } }, { $sort: { count: -1 } }],
        price: [{ $group: { _id: null, min: { $min: '$finalPrice' }, max: { $max: '$finalPrice' } } }],
      },
    },
  ]);

  return ok(res, {
    authors: (agg?.authors || []).map((a) => ({ value: a._id, count: a.count })),
    languages: (agg?.languages || []).map((a) => ({ value: a._id, count: a.count })),
    publishers: (agg?.publishers || []).map((a) => ({ value: a._id, count: a.count })),
    types: (agg?.types || []).map((a) => ({ value: a._id, count: a.count })),
    subCategories: (agg?.subCategories || []).map((a) => ({ value: a._id.slug, label: a._id.name, count: a.count })),
    price: agg?.price?.[0] ? { min: Math.floor(agg.price[0].min || 0), max: Math.ceil(agg.price[0].max || 0) } : { min: 0, max: 0 },
  });
});

/** GET /api/products/:slug — full detail + related + recommended + reviews. */
exports.getBySlug = asyncHandler(async (req, res) => {
  const product = await Product.findOneAndUpdate(
    { slug: req.params.slug, isActive: true, isHidden: false },
    { $inc: { views: 1 } },
    { new: true },
  )
    .populate('category', 'name slug')
    .populate('subCategory', 'name slug')
    .populate({ path: 'relatedProducts', select: CARD_FIELDS, match: { isActive: true } })
    .lean();

  if (!product) throw ApiError.notFound('Product not found');

  // Hide the ebook file path; downloads go through a tokenised endpoint.
  if (product.ebook) {
    product.ebook = {
      isFree: product.ebook.isFree,
      allowPreview: product.ebook.allowPreview,
      previewPages: product.ebook.previewPages,
      pageCount: product.ebook.pageCount,
      sizeBytes: product.ebook.sizeBytes,
      downloadCount: product.ebook.downloadCount,
      available: Boolean(product.ebook.fileUrl),
    };
  }
  delete product.sourcePdf?.path;

  const related = product.relatedProducts?.length
    ? product.relatedProducts
    : await Product.find({
        _id: { $ne: product._id },
        isActive: true,
        isHidden: false,
        $or: [{ subCategorySlug: product.subCategorySlug }, { categorySlug: product.categorySlug }],
      })
        .select(CARD_FIELDS)
        .sort({ soldCount: -1 })
        .limit(12)
        .lean();

  const [recommended, reviews] = await Promise.all([
    Product.find({
      _id: { $nin: [product._id, ...related.map((r) => r._id)] },
      isActive: true,
      isHidden: false,
      categorySlug: product.categorySlug,
    })
      .select(CARD_FIELDS)
      .sort({ 'rating.average': -1, views: -1 })
      .limit(12)
      .lean(),
    Review.find({ product: product._id, isApproved: true }).sort({ createdAt: -1 }).limit(20).lean(),
  ]);

  return ok(res, { product, related, recommended, reviews });
});

/** GET /api/products/:slug/preview — page images for the reader modal. */
exports.preview = asyncHandler(async (req, res) => {
  const product = await Product.findOne({ slug: req.params.slug });
  if (!product) throw ApiError.notFound('Product not found');

  let pdfPages = (product.images || []).filter((i) => i.source === 'pdf').map((i) => i.url);

  // If no pdf pages pre-extracted, check if pdf file exists to extract preview pages on the fly
  if (!pdfPages.length && (product.sourcePdf?.path || product.ebook?.filePath)) {
    const pdfPath = product.sourcePdf?.path || product.ebook?.filePath;
    try {
      const extracted = await pdfService.extractPreviewImages(pdfPath, {
        pages: product.ebook?.previewPages || pdfService.PREVIEW_PAGES,
        folder: 'products',
        altBase: product.title,
      });
      if (extracted.length) {
        pdfPages = extracted.map((i) => i.url);
        product.images = [...(product.images || []), ...extracted];
        product.imagesFromPdf = true;
        await product.save({ validateBeforeSave: false });
      }
    } catch (err) {
      logger.warn(`On-the-fly PDF preview extraction failed for "${product.title}":`, err.message);
    }
  }

  // Fallback to product images if no pdf-specific pages available
  const pages = pdfPages.length ? pdfPages : (product.images || []).map((i) => i.url);

  return ok(res, {
    pages,
    pageCount: product.ebook?.pageCount || product.sourcePdf?.pageCount || pages.length,
  });
});

/** GET /api/products/:slug/ebook — free ebook download (counter + stream/redirect). */
exports.downloadEbook = asyncHandler(async (req, res) => {
  const product = await Product.findOne({ slug: req.params.slug });
  if (!product) throw ApiError.notFound('Product not found');
  if (!product.ebook?.fileUrl) throw ApiError.notFound('No ebook attached to this product');
  if (product.ebook.isFree === false) throw ApiError.forbidden('This ebook is not free');

  product.ebook.downloadCount += 1;
  await product.save({ validateBeforeSave: false });

  const filePath = product.ebook.filePath;
  let fileExists = false;
  if (filePath) {
    try {
      await fs.access(filePath);
      fileExists = true;
    } catch {
      fileExists = false;
    }
  }

  if (fileExists) {
    return res.download(filePath, `${product.slug}.pdf`);
  }

  // File path not available on local filesystem — redirect directly to public URL
  let targetUrl = product.ebook.fileUrl;
  if (targetUrl.startsWith('/')) {
    const host = req.get('host');
    const protocol = req.protocol;
    targetUrl = `${protocol}://${host}${targetUrl}`;
  }
  return res.redirect(targetUrl);
});

/** GET /api/search/suggest?q= — instant suggestions with rich metadata. */
exports.suggest = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 1) return ok(res, { products: [], categories: [], subCategories: [], authors: [] });

  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const [products, categories, subCategories, authorAgg] = await Promise.all([
    Product.find({
      isActive: true,
      isHidden: false,
      $or: [
        { title: rx },
        { author: rx },
        { publisher: rx },
        { categoryName: rx },
        { subCategoryName: rx },
        { language: rx },
        { tags: rx },
        { isbn: rx },
        { description: rx },
      ],
    })
      .select('title slug author price salePrice finalPrice discountPercent images categoryName subCategoryName type')
      .sort({ soldCount: -1, views: -1 })
      .limit(8)
      .lean(),
    Category.find({ name: rx, isActive: true }).select('name slug image').limit(4).lean(),
    SubCategory.find({ name: rx, isActive: true }).select('name slug categorySlug image').limit(5).lean(),
    Product.aggregate([
      { $match: { author: rx, isActive: true } },
      { $group: { _id: '$author', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 4 },
    ]),
  ]);

  SearchHistory.record(q, products.length).catch(() => {});

  return ok(res, {
    products: products.map((p) => ({
      _id: p._id,
      title: p.title,
      slug: p.slug,
      author: p.author,
      type: p.type,
      price: p.finalPrice || p.price,
      mrp: p.price,
      discountPercent: p.discountPercent,
      image: p.images?.[0]?.thumbUrl || p.images?.[0]?.url || '',
      category: p.categoryName || '',
      subCategory: p.subCategoryName || '',
    })),
    categories,
    subCategories,
    authors: authorAgg.map((a) => ({ name: a._id, count: a.count })),
  });
});

/** GET /api/search/popular */
exports.popularSearches = asyncHandler(async (_req, res) => {
  const terms = await SearchHistory.find({ hasNoResults: false }).sort({ count: -1 }).limit(12).select('term count').lean();
  return ok(res, terms.map((t) => t.term));
});

/* ───────────────────────────── admin ───────────────────────────── */

exports.adminList = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const filter = {};

  if (req.query.search) {
    const rx = new RegExp(req.query.search, 'i');
    filter.$or = [{ title: rx }, { author: rx }, { isbn: rx }, { sku: rx }];
  }
  if (req.query.type) filter.type = { $in: String(req.query.type).split(',') };
  if (req.query.category) filter.category = req.query.category;
  if (req.query.subCategory) filter.subCategory = req.query.subCategory;
  if (req.query.isActive !== undefined && req.query.isActive !== '') filter.isActive = bool(req.query.isActive);
  if (req.query.stock === 'out') filter.stock = { $lte: 0 };
  if (req.query.stock === 'low') filter.$expr = { $and: [{ $gt: ['$stock', 0] }, { $lte: ['$stock', '$lowStockThreshold'] }] };

  const sortMap = {
    newest: { createdAt: -1 }, oldest: { createdAt: 1 }, 'price-asc': { finalPrice: 1 },
    'price-desc': { finalPrice: -1 }, 'a-z': { title: 1 }, stock: { stock: 1 }, sold: { soldCount: -1 },
  };

  const [items, total] = await Promise.all([
    Product.find(filter)
      .select(`${CARD_FIELDS} isActive isHidden isLatest isTrending lowStockThreshold views updatedAt imagesFromPdf`)
      .sort(sortMap[req.query.sort] || sortMap.newest)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Product.countDocuments(filter),
  ]);
  return paginated(res, items, { page, limit, total });
});

exports.adminGet = asyncHandler(async (req, res) => {
  const doc = await Product.findById(req.params.id)
    .populate('category', 'name slug')
    .populate('subCategory', 'name slug')
    .populate('relatedProducts', 'title slug images price');
  if (!doc) throw ApiError.notFound('Product not found');
  return ok(res, doc);
});

exports.adminCreate = asyncHandler(async (req, res) => {
  const body = parseProductBody(req.body);
  await syncTaxonomy(body);

  body.slug = await uniqueSlug(Product, body.slug || body.title);
  body.sku = body.sku || `SX-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  const ebookSettings = body.ebookSettings;
  delete body.ebookSettings;

  const doc = new Product(body);
  await syncMedia(doc, req.files || {}, null, ebookSettings);
  await doc.save();

  await Promise.all([
    Category.findByIdAndUpdate(doc.category, { $inc: { productCount: 1 } }),
    doc.subCategory ? SubCategory.findByIdAndUpdate(doc.subCategory, { $inc: { productCount: 1 } }) : null,
  ]);

  shiprocketCatalogueSync.scheduleProductSync(doc);

  return created(res, doc);
});

exports.adminUpdate = asyncHandler(async (req, res) => {
  const doc = await Product.findById(req.params.id);
  if (!doc) throw ApiError.notFound('Product not found');
  const previousCollectionIds = [doc.category, doc.subCategory].filter(Boolean);

  const body = parseProductBody(req.body);
  await syncTaxonomy(body);

  if (body.title && body.title !== doc.title) {
    body.slug = await uniqueSlug(Product, body.slug || body.title, doc._id);
  }

  const keep = Array.isArray(body.keepImages) ? body.keepImages : null;
  delete body.keepImages;

  const ebookSettings = body.ebookSettings;
  delete body.ebookSettings;

  Object.assign(doc, body);
  await syncMedia(doc, req.files || {}, keep, ebookSettings);
  await doc.save();

  shiprocketCatalogueSync.scheduleProductSync(doc, { additionalCollectionIds: previousCollectionIds });

  return ok(res, doc);
});

exports.adminDelete = asyncHandler(async (req, res) => {
  const doc = await Product.findByIdAndDelete(req.params.id);
  if (!doc) throw ApiError.notFound('Product not found');
  await Promise.all([
    Category.findByIdAndUpdate(doc.category, { $inc: { productCount: -1 } }),
    doc.subCategory ? SubCategory.findByIdAndUpdate(doc.subCategory, { $inc: { productCount: -1 } }) : null,
    Review.deleteMany({ product: doc._id }),
  ]);
  shiprocketCatalogueSync.scheduleProductSync(doc, { status: 'deleted' });
  return ok(res, { message: 'Product deleted' });
});

/** PATCH /api/admin/products/:id/flags — quick toggles from the table. */
exports.adminToggleFlags = asyncHandler(async (req, res) => {
  const allowed = ['isActive', 'isHidden', 'isFeatured', 'isTrending', 'isBestSeller', 'isLatest', 'isNewArrival'];
  const update = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = bool(req.body[f]); });
  const doc = await Product.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!doc) throw ApiError.notFound('Product not found');
  shiprocketCatalogueSync.scheduleProductSync(doc);
  return ok(res, doc);
});

/** POST /api/admin/products/:id/regenerate-images — force PDF re-extraction. */
exports.adminRegenerateImages = asyncHandler(async (req, res) => {
  const doc = await Product.findById(req.params.id);
  if (!doc) throw ApiError.notFound('Product not found');

  const source = doc.sourcePdf?.path || doc.ebook?.filePath;
  if (!source) throw ApiError.badRequest('This product has no PDF to extract from');

  const pages = await pdfService.extractPreviewImages(source, {
    pages: Number(req.body.pages) || pdfService.PREVIEW_PAGES,
    folder: 'products',
    altBase: doc.title,
  });
  if (!pages.length) throw ApiError.internal('Could not render the PDF — is poppler-utils installed?');

  doc.images = pages;
  doc.imagesFromPdf = true;
  await doc.save();
  shiprocketCatalogueSync.scheduleProductSync(doc);
  return ok(res, { images: doc.images });
});

/** POST /api/admin/products/bulk — bulk activate/deactivate/delete/flag. */
exports.adminBulk = asyncHandler(async (req, res) => {
  const { ids = [], action, value } = req.body;
  if (!ids.length) throw ApiError.badRequest('No products selected');
  const objectIds = ids.filter(mongoose.isValidObjectId);

  if (action === 'delete') {
    const deleted = await Product.find({ _id: { $in: objectIds } });
    await Product.deleteMany({ _id: { $in: objectIds } });
    deleted.forEach((doc) => shiprocketCatalogueSync.scheduleProductSync(doc, { status: 'deleted' }));
    return ok(res, { message: `${objectIds.length} product(s) deleted` });
  }
  const allowed = ['isActive', 'isHidden', 'isFeatured', 'isTrending', 'isBestSeller', 'isLatest', 'isNewArrival'];
  if (!allowed.includes(action)) throw ApiError.badRequest('Unsupported bulk action');

  await Product.updateMany({ _id: { $in: objectIds } }, { [action]: bool(value) });
  const changed = await Product.find({ _id: { $in: objectIds } });
  changed.forEach((doc) => shiprocketCatalogueSync.scheduleProductSync(doc));
  return ok(res, { message: `${objectIds.length} product(s) updated` });
});

/** GET /api/admin/products/suggestions — Auto-complete options for product form */
exports.adminSuggestions = asyncHandler(async (_req, res) => {
  const [authors, publishers, editions, bindings, titles, tags] = await Promise.all([
    Product.distinct('author', { author: { $ne: null, $ne: '' } }),
    Product.distinct('publisher', { publisher: { $ne: null, $ne: '' } }),
    Product.distinct('edition', { edition: { $ne: null, $ne: '' } }),
    Product.distinct('binding', { binding: { $ne: null, $ne: '' } }),
    Product.find().select('title categoryName author publisher').sort({ createdAt: -1 }).limit(100).lean(),
    Product.distinct('tags'),
  ]);

  const defaultEditions = ['2026 Edition', '2025 Edition', '2024 Edition', 'First Edition', 'Latest Edition'];
  const defaultBindings = ['Paperback', 'Hardcover', 'Spiral Bound', 'Digital eBook', 'Softcover'];

  const mergedEditions = Array.from(new Set([...defaultEditions, ...(editions || []).filter(Boolean)]));
  const mergedBindings = Array.from(new Set([...defaultBindings, ...(bindings || []).filter(Boolean)]));

  return ok(res, {
    authors: (authors || []).filter((a) => a && a !== 'NA').sort(),
    publishers: (publishers || []).filter((p) => p && p !== 'NA').sort(),
    editions: mergedEditions,
    bindings: mergedBindings,
    titles: (titles || []).map((t) => t.title),
    tags: (tags || []).filter(Boolean).sort(),
  });
});
