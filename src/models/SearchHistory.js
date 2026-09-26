const mongoose = require('mongoose');

/**
 * Aggregated search terms. Powers "Popular searches" on the storefront and
 * the search report in the admin dashboard. Per-user recent searches live in
 * the browser's localStorage (there is no login), not here.
 */
const searchHistorySchema = new mongoose.Schema(
  {
    term: { type: String, required: true, lowercase: true, trim: true, unique: true, index: true },
    count: { type: Number, default: 1, index: true },
    resultCount: { type: Number, default: 0 },
    lastSearchedAt: { type: Date, default: Date.now },
    /** Zero-result terms are a merchandising to-do list for the admin. */
    hasNoResults: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

searchHistorySchema.statics.record = function record(term, resultCount = 0) {
  const clean = String(term || '').toLowerCase().trim().slice(0, 80);
  if (clean.length < 2) return Promise.resolve(null);
  return this.findOneAndUpdate(
    { term: clean },
    {
      $inc: { count: 1 },
      $set: { lastSearchedAt: new Date(), resultCount, hasNoResults: resultCount === 0 },
    },
    { upsert: true, new: true },
  );
};

module.exports = mongoose.model('SearchHistory', searchHistorySchema);
