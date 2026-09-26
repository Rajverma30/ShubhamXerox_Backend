const { Schema } = require('mongoose');

/** Reusable stored-image sub-document. */
const imageSchema = new Schema(
  {
    url: { type: String, required: true },
    cardUrl: String,
    thumbUrl: String,
    publicId: String,
    alt: { type: String, default: '' },
    width: Number,
    height: Number,
    /** 'upload' = admin uploaded, 'pdf' = auto-extracted from the source PDF. */
    source: { type: String, enum: ['upload', 'pdf', 'external'], default: 'upload' },
  },
  { _id: false },
);

/** Reusable SEO sub-document used by products, categories, banners, pages. */
const seoSchema = new Schema(
  {
    metaTitle: { type: String, trim: true, maxlength: 160 },
    metaDescription: { type: String, trim: true, maxlength: 320 },
    metaKeywords: [{ type: String, trim: true }],
    ogTitle: String,
    ogDescription: String,
    ogImage: String,
    canonicalUrl: String,
    noIndex: { type: Boolean, default: false },
  },
  { _id: false },
);

const addressSchema = new Schema(
  {
    address: { type: String, required: true, trim: true },
    address2: { type: String, trim: true, default: '' },
    landmark: { type: String, trim: true, default: '' },
    city: { type: String, required: true, trim: true },
    district: { type: String, trim: true, default: '' },
    state: { type: String, required: true, trim: true },
    pincode: { type: String, required: true, trim: true, match: [/^\d{6}$/, 'PIN code must be 6 digits'] },
    country: { type: String, default: 'India', trim: true },
  },
  { _id: false },
);

module.exports = { imageSchema, seoSchema, addressSchema };
