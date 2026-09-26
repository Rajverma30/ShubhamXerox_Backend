const mongoose = require('mongoose');
const Product = require('./Product');

/**
 * Guest reviews (no login). Moderated by the admin before they appear.
 * The product's aggregate rating is recomputed on every approved change.
 */
const reviewSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    title: { type: String, default: '' },
    comment: { type: String, default: '' },
    images: [String],
    isApproved: { type: Boolean, default: false, index: true },
    isVerifiedPurchase: { type: Boolean, default: false },
    orderNumber: String,
    guestId: String,
    helpfulCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

reviewSchema.statics.recalculate = async function recalculate(productId) {
  const [agg] = await this.aggregate([
    { $match: { product: new mongoose.Types.ObjectId(productId), isApproved: true } },
    { $group: { _id: '$product', average: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  await Product.findByIdAndUpdate(productId, {
    'rating.average': agg ? Math.round(agg.average * 10) / 10 : 0,
    'rating.count': agg ? agg.count : 0,
  });
};

reviewSchema.post('save', function afterSave() {
  this.constructor.recalculate(this.product).catch(() => {});
});
reviewSchema.post('findOneAndUpdate', function afterUpdate(doc) {
  if (doc) doc.constructor.recalculate(doc.product).catch(() => {});
});
reviewSchema.post('findOneAndDelete', function afterDelete(doc) {
  if (doc) doc.constructor.recalculate(doc.product).catch(() => {});
});

module.exports = mongoose.model('Review', reviewSchema);
