/**
 * The homepage payload. Built entirely from HomeSection + Banner documents so
 * the admin's "Homepage builder" fully controls what the storefront renders.
 */
const { HomeSection, Banner, Product, Category, SubCategory, Setting, Coupon } = require('../models');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');
const { SORTS } = require('../utils/queryFeatures');

const CARD_FIELDS =
  'title slug type author price salePrice discountPercent finalPrice stock images rating soldCount ' +
  'categorySlug subCategorySlug categoryName subCategoryName hasFreeEbook createdAt';

/** Resolves the products for one dynamic section. */
async function resolveSectionProducts(section) {
  if (section.products?.length) {
    const picked = await Product.find({ _id: { $in: section.products }, isActive: true, isHidden: false })
      .select(CARD_FIELDS)
      .lean();
    // Preserve the admin's hand-picked order.
    const order = new Map(section.products.map((id, i) => [String(id), i]));
    return picked.sort((a, b) => (order.get(String(a._id)) ?? 0) - (order.get(String(b._id)) ?? 0));
  }

  const filter = { isActive: true, isHidden: false };
  if (section.categorySlug) filter.categorySlug = section.categorySlug;
  if (section.subCategorySlug) filter.subCategorySlug = section.subCategorySlug;
  if (section.productType) filter.type = section.productType;

  // Section type implies a merchandising flag.
  const flagByType = {
    'latest-books': 'isLatest',
    'trending-books': 'isTrending',
    'featured-books': 'isFeatured',
    'best-sellers': 'isBestSeller',
    'new-arrivals': 'isNewArrival',
  };
  const flag = flagByType[section.type];
  if (flag) filter[flag] = true;
  if (section.type === 'offers') filter.discountPercent = { $gt: 0 };

  const sort = SORTS[section.sort] || SORTS.newest;
  let items = await Product.find(filter).select(CARD_FIELDS).sort(sort).limit(section.limit || 12).lean();

  // Graceful fallback: if a flag-based section is empty, fall back to newest.
  if (!items.length && flag) {
    delete filter[flag];
    items = await Product.find(filter).select(CARD_FIELDS).sort(SORTS.newest).limit(section.limit || 12).lean();
  }
  return items;
}

/** GET /api/home — one request, whole homepage. */
exports.home = asyncHandler(async (_req, res) => {
  const [sections, settings] = await Promise.all([
    HomeSection.find({ isActive: true }).sort({ order: 1 }).lean(),
    Setting.getSingleton(),
  ]);

  const resolved = await Promise.all(
    sections.map(async (section) => {
      const base = {
        key: section.key,
        type: section.type,
        title: section.title,
        subtitle: section.subtitle,
        layout: section.layout,
        theme: section.theme,
        viewAllUrl: section.viewAllUrl,
      };

      switch (section.type) {
        case 'hero-slider':
          return { ...base, banners: await Banner.find(Banner.liveQuery('hero')).sort({ priority: -1, createdAt: -1 }).limit(8).lean() };

        case 'banner-strip':
          return {
            ...base,
            banners: await Banner.find(Banner.liveQuery(section.bannerPlacement || 'offer'))
              .sort({ priority: -1 })
              .limit(section.limit || 3)
              .lean(),
          };

        case 'featured-categories':
          return {
            ...base,
            categories: await Category.find({ isActive: true, showOnHomepage: true })
              .sort({ order: 1 })
              .limit(section.limit || 12)
              .lean(),
          };

        case 'popular-subcategories':
          return {
            ...base,
            subCategories: await SubCategory.find({ isActive: true, isPopular: true })
              .sort({ order: 1 })
              .limit(section.limit || 16)
              .lean(),
          };

        case 'testimonials':
          return { ...base, testimonials: settings.testimonials || [] };

        case 'newsletter':
          return base;

        default:
          return { ...base, products: await resolveSectionProducts(section) };
      }
    }),
  );

  const [popupBanner, coupons] = await Promise.all([
    Banner.findOne(Banner.liveQuery('popup')).sort({ priority: -1 }).lean(),
    Coupon.find({ isActive: true, showOnSite: true }).select('code description type value minOrderValue maxDiscount expiresAt').limit(6).lean(),
  ]);

  return ok(res, {
    sections: resolved.filter((s) => {
      const arr = s.products || s.banners || s.categories || s.subCategories || s.testimonials;
      return arr === undefined || arr.length > 0;
    }),
    popupBanner,
    coupons,
  });
});

/* ───────────── admin: homepage builder ───────────── */

exports.adminList = asyncHandler(async (_req, res) => {
  const sections = await HomeSection.find().sort({ order: 1 }).populate('products', 'title slug images price').lean();
  return ok(res, sections);
});

exports.adminCreate = asyncHandler(async (req, res) => {
  const section = await HomeSection.create(req.body);
  return ok(res, section);
});

exports.adminUpdate = asyncHandler(async (req, res) => {
  const section = await HomeSection.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  return ok(res, section);
});

exports.adminDelete = asyncHandler(async (req, res) => {
  await HomeSection.findByIdAndDelete(req.params.id);
  return ok(res, { message: 'Section removed' });
});

exports.adminReorder = asyncHandler(async (req, res) => {
  const { items = [] } = req.body;
  await Promise.all(items.map(({ id, order }) => HomeSection.findByIdAndUpdate(id, { order })));
  return ok(res, { message: 'Homepage order saved' });
});
