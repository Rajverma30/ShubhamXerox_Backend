const mongoose = require('mongoose');

/**
 * Lightweight, cookie-less analytics: one document per day per anonymous
 * guest id. Feeds the "Visitors" dashboard card without any third party.
 */
const visitorSchema = new mongoose.Schema(
  {
    day: { type: String, required: true, index: true }, // YYYY-MM-DD
    guestId: { type: String, required: true },
    pageViews: { type: Number, default: 1 },
    lastPath: String,
    referrer: String,
    userAgent: String,
    country: String,
  },
  { timestamps: true },
);

visitorSchema.index({ day: 1, guestId: 1 }, { unique: true });

visitorSchema.statics.track = function track({ guestId, path, referrer, userAgent }) {
  if (!guestId) return Promise.resolve(null);
  const day = new Date().toISOString().slice(0, 10);
  return this.findOneAndUpdate(
    { day, guestId },
    { $inc: { pageViews: 1 }, $set: { lastPath: path, referrer, userAgent } },
    { upsert: true, new: true },
  );
};

module.exports = mongoose.model('Visitor', visitorSchema);
