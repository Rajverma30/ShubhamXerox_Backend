const mongoose = require('mongoose');
const { seoSchema } = require('./_shared');

/** Singleton document holding global store configuration. */
const settingSchema = new mongoose.Schema(
  {
    singleton: { type: String, default: 'global', unique: true, immutable: true },

    storeName: { type: String, default: 'Shubham Xerox' },
    tagline: { type: String, default: 'Books, Exam Guides & Stationery' },
    logo: { type: String, default: '/logo.png' },
    logoDark: { type: String, default: '/logo.png' },
    favicon: { type: String, default: '/favicon.png' },

    email: { type: String, default: 'support@shubhamxerox.com' },
    phone: { type: String, default: '' },
    whatsapp: { type: String, default: '' },
    address: { type: String, default: '' },
    mapEmbedUrl: { type: String, default: '' },
    openingHours: { type: String, default: 'Mon–Sat, 9:00 AM – 8:00 PM' },

    social: {
      facebook: String,
      instagram: String,
      youtube: String,
      twitter: String,
      telegram: String,
    },

    /* commerce */
    currency: { type: String, default: 'INR' },
    currencySymbol: { type: String, default: '₹' },
    taxPercent: { type: Number, default: 0 },
    shippingFlat: { type: Number, default: 49 },
    freeShippingAbove: { type: Number, default: 499 },
    codEnabled: { type: Boolean, default: true },
    codFee: { type: Number, default: 0 },
    prepaidEnabled: { type: Boolean, default: true },
    minOrderValue: { type: Number, default: 0 },

    /* content */
    announcementBar: {
      enabled: { type: Boolean, default: true },
      text: { type: String, default: 'Free delivery on orders above ₹499' },
      url: String,
    },
    testimonials: [
      {
        name: String,
        role: String,
        avatar: String,
        rating: { type: Number, default: 5 },
        text: String,
        _id: false,
      },
    ],
    footerLinks: [{ label: String, url: String, group: String, _id: false }],
    policies: {
      shipping: String,
      returns: String,
      privacy: String,
      terms: String,
      about: String,
    },

    /**
     * Storefront checkout configuration.
     *
     * Secrets stay in environment variables. The admin only chooses the
     * active provider, so checkout credentials can never leak to a browser.
     */
    checkout: {
      // Legacy values remain accepted so an old Settings document can be
      // opened; every dashboard save normalises it to Razorpay or Shiprocket.
      mode: { type: String, enum: ['razorpay', 'shiprocket', 'auto', 'whatsapp', 'off'], default: 'razorpay' },
    },

    shiprocketAutoPush: { type: Boolean, default: true },

    /* search merchandising */
    popularSearches: [{ type: String }],

    seo: seoSchema,
    maintenanceMode: { type: Boolean, default: false },
    googleAnalyticsId: String,
    facebookPixelId: String,
  },
  { timestamps: true },
);

/** Always returns the singleton, creating it on first call. */
settingSchema.statics.getSingleton = async function getSingleton() {
  let doc = await this.findOne({ singleton: 'global' });
  if (!doc) doc = await this.create({ singleton: 'global' });
  return doc;
};

module.exports = mongoose.model('Setting', settingSchema);
