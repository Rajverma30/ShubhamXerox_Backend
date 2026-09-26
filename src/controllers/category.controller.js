const { Category, SubCategory, Product } = require('../models');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/response');
const { uniqueSlug } = require('../utils/slug');
const { cleanRichText, cleanText } = require('../utils/sanitize');
const imageService = require('../services/image.service');
const shiprocketCatalogueSync = require('../services/shiprocketCatalogSync.service');

/** Turn multer's `req.files` into image sub-documents. */
async function attachImages(files, target) {
  if (!files) return;
  const jobs = [];
  if (files.image?.[0]) jobs.push(imageService.processImage(files.image[0].path, { folder: 'media' }).then((i) => { target.image = i; }));
  if (files.banner?.[0]) jobs.push(imageService.processImage(files.banner[0].path, { folder: 'banners' }).then((i) => { target.banner = i; }));
  if (files.icon?.[0]) jobs.push(imageService.processImage(files.icon[0].path, { folder: 'media' }).then((i) => { target.icon = i.url; }));
  await Promise.all(jobs);
}

function parseBody(body) {
  const out = { ...body };
  if (out.description) out.description = cleanRichText(out.description);
  if (out.name) out.name = cleanText(out.name);
  if (typeof out.seo === 'string') out.seo = JSON.parse(out.seo);
  ['isActive', 'isFeatured', 'showOnHomepage', 'isPopular'].forEach((f) => {
    if (out[f] !== undefined) out[f] = String(out[f]) === 'true' || out[f] === true;
  });
  if (out.order !== undefined) out.order = Number(out.order) || 0;
  return out;
}

/* ───────────────────────── public ───────────────────────── */

/** GET /api/categories — tree of active categories with their subcategories. */
exports.listPublic = asyncHandler(async (req, res) => {
  const withSubs = String(req.query.withSubCategories ?? 'true') === 'true';
  const categories = await Category.find({ isActive: true })
    .sort({ order: 1, name: 1 })
    .select('-__v')
    .lean();

  if (withSubs) {
    const subs = await SubCategory.find({ isActive: true }).sort({ order: 1, name: 1 }).lean();
    const byCat = subs.reduce((acc, s) => {
      const k = String(s.category);
      (acc[k] = acc[k] || []).push(s);
      return acc;
    }, {});
    categories.forEach((c) => { c.subCategories = byCat[String(c._id)] || []; });
  }
  return ok(res, categories);
});

/** GET /api/categories/:slug */
exports.getBySlug = asyncHandler(async (req, res) => {
  const rawSlug = String(req.params.slug || '').toLowerCase().trim();
  let category = await Category.findOne({ slug: rawSlug, isActive: true }).lean();

  if (!category) {
    const virtuals = {
      'mppsc-books': {
        name: 'MPPSC Books & Study Material',
        slug: 'mppsc-books',
        shortDescription: 'Buy MPPSC Mains, Prelims, Solved Papers, and Notes online at best price in Hindi and English medium.',
        seo: { metaTitle: 'MPPSC Books & Study Material Online | Shubham Xerox', metaDescription: 'Buy MPPSC Mains books, Prelims guides, solved papers, and Hindi/English notes online from Shubham Xerox Indore.' },
      },
      'mppsc-mains-books': {
        name: 'MPPSC Mains Books & Notes',
        slug: 'mppsc-mains-books',
        shortDescription: 'Comprehensive MPPSC Mains Paper 1 to Paper 6 preparation books, unit-wise notes, and answer writing guides.',
        seo: { metaTitle: 'MPPSC Mains Books & Study Material | Shubham Xerox', metaDescription: 'Best MPPSC Mains books, summary notes, paper-wise guides in Hindi & English medium.' },
      },
      'mpesb-books': {
        name: 'MPESB & Vyapam Exam Books',
        slug: 'mpesb-books',
        shortDescription: 'Books and solved papers for MPESB, Vyapam, MP Patwari, MP Police Constable, MP SI, and Samvidha Shikshak.',
        seo: { metaTitle: 'MPESB & Vyapam Books Online | Shubham Xerox', metaDescription: 'Buy MPESB preparation books, Patwari guides, MP Police solved papers online from Shubham Xerox.' },
      },
      'current-affairs-books': {
        name: 'Current Affairs & Speedy Books',
        slug: 'current-affairs-books',
        shortDescription: 'Monthly and yearly MP Current Affairs, Speedy Current Affairs in Hindi, Ghatna Chakra Current Affairs.',
        seo: { metaTitle: 'Speedy Current Affairs & MP Current Books | Shubham Xerox', metaDescription: 'Buy Speedy Current Affairs, MP Current Affairs, yearly guides online at Shubham Xerox.' },
      },
      'ghatna-chakra-books': {
        name: 'Ghatna Chakra Series',
        slug: 'ghatna-chakra-books',
        shortDescription: 'Complete Ghatna Chakra Purvavlokan series for History, Polity, Geography, Science, and Environment.',
        seo: { metaTitle: 'Ghatna Chakra Books & Purvavlokan Series | Shubham Xerox', metaDescription: 'Buy Ghatna Chakra Purvavlokan books online at best price from Shubham Xerox.' },
      },
    };

    if (virtuals[rawSlug]) {
      category = virtuals[rawSlug];
    } else {
      throw ApiError.notFound('Category not found');
    }
  } else {
    category.subCategories = await SubCategory.find({ category: category._id, isActive: true })
      .sort({ order: 1, name: 1 })
      .lean();
  }
  return ok(res, category);
});

/** GET /api/subcategories?category=slug */
exports.listSubCategoriesPublic = asyncHandler(async (req, res) => {
  const filter = { isActive: true };
  if (req.query.category) filter.categorySlug = req.query.category;
  if (req.query.popular === 'true') filter.isPopular = true;
  const subs = await SubCategory.find(filter)
    .sort({ order: 1, name: 1 })
    .limit(Number(req.query.limit) || 200)
    .lean();
  return ok(res, subs);
});

/** GET /api/subcategories/:slug */
exports.getSubCategoryBySlug = asyncHandler(async (req, res) => {
  const sub = await SubCategory.findOne({ slug: req.params.slug, isActive: true })
    .populate('category', 'name slug')
    .lean();
  if (!sub) throw ApiError.notFound('Sub category not found');
  return ok(res, sub);
});

/* ───────────────────────── admin: categories ───────────────────────── */

exports.adminList = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 50);
  const filter = {};
  if (req.query.search) filter.name = new RegExp(req.query.search, 'i');
  if (req.query.isActive) filter.isActive = req.query.isActive === 'true';

  const [items, total] = await Promise.all([
    Category.find(filter).sort({ order: 1, name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Category.countDocuments(filter),
  ]);
  return paginated(res, items, { page, limit, total });
});

exports.adminGet = asyncHandler(async (req, res) => {
  const doc = await Category.findById(req.params.id).populate('subCategories');
  if (!doc) throw ApiError.notFound('Category not found');
  return ok(res, doc);
});

exports.adminCreate = asyncHandler(async (req, res) => {
  const body = parseBody(req.body);
  body.slug = await uniqueSlug(Category, body.slug || body.name);
  await attachImages(req.files, body);
  const doc = await Category.create(body);
  shiprocketCatalogueSync.scheduleCollectionSync(doc);
  return created(res, doc);
});

exports.adminUpdate = asyncHandler(async (req, res) => {
  const doc = await Category.findById(req.params.id);
  if (!doc) throw ApiError.notFound('Category not found');

  const body = parseBody(req.body);
  if (body.name && body.name !== doc.name) {
    body.slug = await uniqueSlug(Category, body.slug || body.name, doc._id);
  }
  await attachImages(req.files, body);
  Object.assign(doc, body);
  await doc.save();

  // Keep the denormalised slug on subcategories/products in sync.
  if (body.slug) {
    await Promise.all([
      SubCategory.updateMany({ category: doc._id }, { categorySlug: doc.slug }),
      Product.updateMany({ category: doc._id }, { categorySlug: doc.slug, categoryName: doc.name }),
    ]);
  }
  shiprocketCatalogueSync.scheduleCollectionSync(doc);
  return ok(res, doc);
});

exports.adminDelete = asyncHandler(async (req, res) => {
  const inUse = await Product.countDocuments({ category: req.params.id });
  if (inUse) throw ApiError.conflict(`${inUse} product(s) still use this category`);
  const doc = await Category.findByIdAndDelete(req.params.id);
  if (!doc) throw ApiError.notFound('Category not found');
  await SubCategory.deleteMany({ category: doc._id });
  shiprocketCatalogueSync.scheduleCollectionSync(doc, { status: 'deleted' });
  return ok(res, { message: 'Category deleted' });
});

exports.adminReorder = asyncHandler(async (req, res) => {
  const { items = [] } = req.body; // [{ id, order }]
  await Promise.all(items.map(({ id, order }) => Category.findByIdAndUpdate(id, { order })));
  return ok(res, { message: 'Order saved' });
});

/* ───────────────────────── admin: subcategories ───────────────────────── */

exports.adminListSub = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const filter = {};
  if (req.query.category) filter.category = req.query.category;
  if (req.query.search) filter.name = new RegExp(req.query.search, 'i');

  const [items, total] = await Promise.all([
    SubCategory.find(filter)
      .populate('category', 'name slug')
      .sort({ order: 1, name: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    SubCategory.countDocuments(filter),
  ]);
  return paginated(res, items, { page, limit, total });
});

exports.adminGetSub = asyncHandler(async (req, res) => {
  const doc = await SubCategory.findById(req.params.id).populate('category', 'name slug');
  if (!doc) throw ApiError.notFound('Sub category not found');
  return ok(res, doc);
});

exports.adminCreateSub = asyncHandler(async (req, res) => {
  const body = parseBody(req.body);
  const parent = await Category.findById(body.category);
  if (!parent) throw ApiError.badRequest('Parent category not found');

  body.categorySlug = parent.slug;
  body.slug = await uniqueSlug(SubCategory, body.slug || `${parent.name}-${body.name}`);
  await attachImages(req.files, body);

  const doc = await SubCategory.create(body);
  shiprocketCatalogueSync.scheduleCollectionSync(doc, { isSubCategory: true });
  return created(res, doc);
});

exports.adminUpdateSub = asyncHandler(async (req, res) => {
  const doc = await SubCategory.findById(req.params.id);
  if (!doc) throw ApiError.notFound('Sub category not found');

  const body = parseBody(req.body);
  if (body.category) {
    const parent = await Category.findById(body.category);
    if (!parent) throw ApiError.badRequest('Parent category not found');
    body.categorySlug = parent.slug;
  }
  if (body.name && body.name !== doc.name) {
    body.slug = await uniqueSlug(SubCategory, body.slug || body.name, doc._id);
  }
  await attachImages(req.files, body);
  Object.assign(doc, body);
  await doc.save();

  if (body.slug) {
    await Product.updateMany({ subCategory: doc._id }, { subCategorySlug: doc.slug, subCategoryName: doc.name });
  }
  shiprocketCatalogueSync.scheduleCollectionSync(doc, { isSubCategory: true });
  return ok(res, doc);
});

exports.adminDeleteSub = asyncHandler(async (req, res) => {
  const inUse = await Product.countDocuments({ subCategory: req.params.id });
  if (inUse) throw ApiError.conflict(`${inUse} product(s) still use this sub category`);
  const doc = await SubCategory.findByIdAndDelete(req.params.id);
  if (!doc) throw ApiError.notFound('Sub category not found');
  shiprocketCatalogueSync.scheduleCollectionSync(doc, { isSubCategory: true, status: 'deleted' });
  return ok(res, { message: 'Sub category deleted' });
});
