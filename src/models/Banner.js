const mongoose = require('mongoose');
const { imageSchema } = require('./_shared');
const { BANNER_PLACEMENTS } = require('../config/constants');

/**
 * Fully dynamic banners. One document can carry separate artwork per
 * breakpoint, an optional schedule window, and a CTA.
 */
const bannerSchema = new mongoose.Schema(
  {
    title: { type: String, default: '' },
    subtitle: { type: String, default: '' },
    eyebrow: { type: String, default: '' },
    description: { type: String, default: '' },

    placement: { type: String, enum: BANNER_PLACEMENTS, default: 'hero', index: true },

    image: imageSchema, // desktop / default
    tabletImage: imageSchema,
    mobileImage: imageSchema,

    buttonText: { type: String, default: '' },
    buttonUrl: { type: String, default: '' },
    secondaryButtonText: { type: String, default: '' },
    secondaryButtonUrl: { type: String, default: '' },

    /** Scoping for category / subcategory placements. */
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
    subCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'SubCategory' },

    textAlign: { type: String, enum: ['left', 'center', 'right'], default: 'left' },
    theme: { type: String, enum: ['light', 'dark'], default: 'dark' },
    overlayOpacity: { type: Number, default: 0.35, min: 0, max: 1 },

    priority: { type: Number, default: 0, index: true },
    isActive: { type: Boolean, default: true, index: true },
    startsAt: Date,
    endsAt: Date,
    clicks: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
  },
  { timestamps: true },
);

/** Placement + schedule aware query helper. */
bannerSchema.statics.liveQuery = function liveQuery(placement) {
  const now = new Date();
  return {
    ...(placement ? { placement } : {}),
    isActive: true,
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $exists: false } }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }] },
    ],
  };
};

module.exports = mongoose.model('Banner', bannerSchema);
