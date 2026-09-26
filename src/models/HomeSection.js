const mongoose = require('mongoose');
const { HOME_SECTION_TYPES } = require('../config/constants');

/**
 * The homepage builder. The storefront renders /api/home by walking these
 * documents in `order`, so the admin controls what appears and in what
 * sequence with zero code changes.
 */
const homeSectionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true }, // stable id, e.g. 'latest-books'
    type: { type: String, enum: HOME_SECTION_TYPES, required: true },
    title: { type: String, default: '' },
    subtitle: { type: String, default: '' },
    /** Storefront route for the section's "View all" link. */
    viewAllUrl: { type: String, default: '' },
    layout: { type: String, enum: ['grid', 'carousel', 'banner', 'masonry'], default: 'carousel' },
    limit: { type: Number, default: 12 },
    /** Optional scoping for product sections. */
    categorySlug: { type: String, default: '' },
    subCategorySlug: { type: String, default: '' },
    productType: { type: String, default: '' },
    sort: { type: String, default: 'newest' },
    /** Hand-picked products override the automatic query when non-empty. */
    products: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    bannerPlacement: { type: String, default: '' },
    order: { type: Number, default: 0, index: true },
    isActive: { type: Boolean, default: true, index: true },
    theme: { type: String, enum: ['default', 'tinted', 'dark'], default: 'default' },
  },
  { timestamps: true },
);

module.exports = mongoose.model('HomeSection', homeSectionSchema);
