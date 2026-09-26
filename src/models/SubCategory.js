const mongoose = require('mongoose');
const { imageSchema, seoSchema } = require('./_shared');

/** Second-level taxonomy: SSC, UPSC, Class 8, Pen, Notebook, … */
const subCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Sub category name is required'], trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
    /** Denormalised for fast storefront filtering without a join. */
    categorySlug: { type: String, required: true, index: true },
    description: { type: String, default: '' },
    shortDescription: { type: String, default: '', maxlength: 220 },
    icon: { type: String, default: '' },
    image: imageSchema,
    banner: imageSchema,
    order: { type: Number, default: 0, index: true },
    isActive: { type: Boolean, default: true, index: true },
    isPopular: { type: Boolean, default: false, index: true },
    productCount: { type: Number, default: 0 },
    seo: seoSchema,
  },
  { timestamps: true },
);

subCategorySchema.index({ category: 1, name: 1 }, { unique: true });
subCategorySchema.index({ name: 'text' });

module.exports = mongoose.model('SubCategory', subCategorySchema);
