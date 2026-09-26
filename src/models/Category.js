const mongoose = require('mongoose');
const { imageSchema, seoSchema } = require('./_shared');

/** Top-level taxonomy: Exam Books, School Books, Stationery, … */
const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Category name is required'], trim: true, unique: true },
    slug: { type: String, required: true, unique: true, index: true },
    description: { type: String, default: '' },
    shortDescription: { type: String, default: '', maxlength: 220 },
    /** Icon name from react-icons, or an uploaded icon image URL. */
    icon: { type: String, default: '' },
    image: imageSchema,
    banner: imageSchema,
    /** Accent used by the storefront for gradient cards. */
    color: { type: String, default: '#0f172a' },
    order: { type: Number, default: 0, index: true },
    isActive: { type: Boolean, default: true, index: true },
    isFeatured: { type: Boolean, default: false, index: true },
    showOnHomepage: { type: Boolean, default: true },
    productCount: { type: Number, default: 0 },
    seo: seoSchema,
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

categorySchema.virtual('subCategories', {
  ref: 'SubCategory',
  localField: '_id',
  foreignField: 'category',
});

categorySchema.index({ name: 'text', description: 'text' });

module.exports = mongoose.model('Category', categorySchema);
