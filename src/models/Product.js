const mongoose = require('mongoose');
const { imageSchema, seoSchema } = require('./_shared');
const { PRODUCT_TYPES } = require('../config/constants');

/**
 * One collection backs Books, Ebooks, Stationery and "Book + Free Ebook".
 * `type` discriminates, and the API exposes /books, /ebooks and /stationery
 * as filtered views — that keeps search, filters and the cart uniform while
 * still giving the admin panel dedicated screens per product family.
 */
const ebookSchema = new mongoose.Schema(
  {
    fileUrl: String,
    filePath: String,
    filename: String,
    sizeBytes: Number,
    pageCount: Number,
    /** Free downloads are the default; a price makes it a paid digital item. */
    isFree: { type: Boolean, default: true },
    allowPreview: { type: Boolean, default: true },
    previewPages: { type: Number, default: 5 },
    downloadCount: { type: Number, default: 0 },
  },
  { _id: false },
);

const productSchema = new mongoose.Schema(
  {
    /* ── identity ── */
    title: { type: String, required: [true, 'Title is required'], trim: true, index: true },
    slug: { type: String, required: true, unique: true, index: true },
    oldSlugs: [{ type: String, trim: true, index: true }],
    sku: { type: String, unique: true, sparse: true, trim: true },
    type: { type: String, enum: PRODUCT_TYPES, default: 'book', index: true },

    /* ── book metadata ── */
    author: { type: String, trim: true, default: '', index: true },
    publisher: { type: String, trim: true, default: '' },
    isbn: { type: String, trim: true, default: '' },
    edition: { type: String, trim: true, default: '' },
    /**
     * A title can genuinely be bilingual — most MPPSC guides carry Hindi and
     * English in the same book — so this is an array.
     *
     * Kept BACKWARD COMPATIBLE on purpose: a setter accepts the old single
     * string, so existing code, the seeder and any admin form that has not
     * been updated yet all keep working. Run `npm run migrate:language` to
     * convert the stored values; nothing breaks if you do not.
     */
    language: {
      type: [String],
      default: ['English'],
      index: true,
      set: (v) => {
        if (v === undefined || v === null || v === '') return undefined;
        const arr = Array.isArray(v) ? v : String(v).split(',');
        const clean = arr.map((x) => String(x).trim()).filter(Boolean);
        return [...new Set(clean)];
      },
    },
    pages: { type: Number, default: null },
    publishYear: Number,
    binding: { type: String, default: '' },

    /* ── stationery metadata ── */
    brand: { type: String, trim: true, default: '' },
    color: { type: String, default: '' },
    material: { type: String, default: '' },

    /* ── shipping metadata ── */
    weight: { type: Number, default: 0.3 }, // kg
    dimensions: {
      length: { type: Number, default: 22 },
      breadth: { type: Number, default: 15 },
      height: { type: Number, default: 2 },
      unit: { type: String, default: 'cm' },
    },

    /* ── pricing ── */
    price: { type: Number, required: [true, 'Price is required'], min: 0 },
    salePrice: { type: Number, default: null, min: 0 },
    discountPercent: { type: Number, default: 0, min: 0, max: 95, index: true },
    /** Persisted so we can sort/filter on the final price cheaply. */
    finalPrice: { type: Number, default: 0, index: true },
    currency: { type: String, default: 'INR' },
    taxPercent: { type: Number, default: 0 },

    /* ── inventory ── */
    stock: { type: Number, default: 10, min: 3 },
    lowStockThreshold: { type: Number, default: 5 },
    allowBackorder: { type: Boolean, default: false },

    /* ── content ── */
    description: { type: String, default: '' }, // rich text (sanitised)
    shortDescription: { type: String, default: '', maxlength: 320 },
    highlights: [{ type: String, trim: true }],
    specifications: [{ label: String, value: String, _id: false }],

    /* ── taxonomy ── */
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
    categorySlug: { type: String, required: true, index: true },
    categoryName: String,
    subCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'SubCategory', index: true },
    subCategorySlug: { type: String, index: true },
    subCategoryName: String,
    tags: [{ type: String, trim: true, lowercase: true, index: true }],

    /* ── media ── */
    images: { type: [imageSchema], default: [] },
    /** Source PDF used to auto-generate gallery images. */
    sourcePdf: {
      url: String,
      path: String,
      filename: String,
      sizeBytes: Number,
      pageCount: Number,
    },
    /** True when `images` were rasterised from sourcePdf rather than uploaded. */
    imagesFromPdf: { type: Boolean, default: false },

    /* ── free ebook ── */
    hasFreeEbook: { type: Boolean, default: false, index: true },
    ebook: ebookSchema,

    /* ── merchandising flags ── */
    isFeatured: { type: Boolean, default: false, index: true },
    isTrending: { type: Boolean, default: false, index: true },
    isBestSeller: { type: Boolean, default: false, index: true },
    isLatest: { type: Boolean, default: false, index: true },
    isNewArrival: { type: Boolean, default: false, index: true },
    isActive: { type: Boolean, default: true, index: true },
    isHidden: { type: Boolean, default: false, index: true },

    /* ── stats ── */
    rating: {
      average: { type: Number, default: 0, min: 0, max: 5 },
      count: { type: Number, default: 0 },
    },
    views: { type: Number, default: 0 },
    soldCount: { type: Number, default: 0, index: true },
    wishlistCount: { type: Number, default: 0 },

    relatedProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    order: { type: Number, default: 0 },
    seo: seoSchema,
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

/* ── indexes ── */
/**
 * Text index for search.
 *
 * `language_override` is important: by default MongoDB reads each document's
 * `language` field and treats it as the text-index language. Our `language`
 * field holds human values like "Hindi", "Odia" or "NA", which are not valid
 * text-search languages, so inserts would fail with
 * `language override unsupported: Hindi` (error 17262).
 *
 * Pointing the override at an unused field name (`searchLanguage`) makes the
 * index ignore `language` entirely and fall back to `default_language`.
 *
 * This matters even more now that `language` is an ARRAY — Mongo would reject
 * the document outright rather than merely complain about an unknown language.
 */
productSchema.index(
  { title: 'text', author: 'text', publisher: 'text', isbn: 'text', tags: 'text', shortDescription: 'text' },
  {
    weights: { title: 10, author: 6, tags: 4, isbn: 8, publisher: 2, shortDescription: 1 },
    name: 'product_search',
    default_language: 'english',
    language_override: 'searchLanguage',
  },
);
productSchema.index({ isActive: 1, isHidden: 1, createdAt: -1 });
productSchema.index({ categorySlug: 1, subCategorySlug: 1, isActive: 1 });

/* ── virtuals ── */
productSchema.virtual('inStock').get(function inStock() {
  return this.allowBackorder || this.stock > 0 || this.type === 'ebook';
});
productSchema.virtual('isLowStock').get(function isLowStock() {
  return this.stock > 0 && this.stock <= this.lowStockThreshold;
});
productSchema.virtual('isShippable').get(function isShippable() {
  return this.type !== 'ebook';
});

/** Keep finalPrice / discountPercent / hasFreeEbook consistent on every write. */
productSchema.pre('save', function syncDerived(next) {
  // finalPrice must match utils/pricing.js -> sellingPrice(): whole rupees, so
  // the displayed, charged and externally-synced prices never disagree.
  if (this.salePrice && this.salePrice > 0 && this.price > 0) {
    this.discountPercent = Math.round(((this.price - this.salePrice) / this.price) * 100);
    this.finalPrice = Math.round(this.salePrice);
  } else {
    this.finalPrice = Math.round(this.price * (1 - (this.discountPercent || 0) / 100));
  }
  if (this.type !== 'ebook' && (this.stock === undefined || this.stock === null || this.stock < 3)) {
    this.stock = 3;
  }
  this.hasFreeEbook = Boolean(this.ebook?.fileUrl && this.ebook?.isFree !== false);
  if (this.type === 'book' && this.hasFreeEbook) this.type = 'book+ebook';
  return next();
});

module.exports = mongoose.model('Product', productSchema);
