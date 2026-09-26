const mongoose = require('mongoose');
const { COUPON_TYPES } = require('../config/constants');

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
    description: { type: String, default: '' },
    type: { type: String, enum: COUPON_TYPES, default: 'percent' },
    value: { type: Number, default: 0, min: 0 },
    maxDiscount: { type: Number, default: null },
    minOrderValue: { type: Number, default: 0 },
    usageLimit: { type: Number, default: null }, // null = unlimited
    usedCount: { type: Number, default: 0 },
    perCustomerLimit: { type: Number, default: null },
    startsAt: { type: Date, default: Date.now },
    expiresAt: Date,
    /** Restrict to specific taxonomy/products; empty = applies to everything. */
    categories: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Category' }],
    products: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    isActive: { type: Boolean, default: true, index: true },
    showOnSite: { type: Boolean, default: true },
  },
  { timestamps: true },
);

/** True when the coupon can be applied right now for `subtotal`. */
couponSchema.methods.isUsable = function isUsable(subtotal = 0) {
  const now = Date.now();
  if (!this.isActive) return { ok: false, reason: 'This coupon is not active' };
  if (this.startsAt && now < this.startsAt.getTime()) return { ok: false, reason: 'This coupon is not live yet' };
  if (this.expiresAt && now > this.expiresAt.getTime()) return { ok: false, reason: 'This coupon has expired' };
  if (this.usageLimit !== null && this.usedCount >= this.usageLimit) {
    return { ok: false, reason: 'This coupon has been fully redeemed' };
  }
  if (subtotal < (this.minOrderValue || 0)) {
    return { ok: false, reason: `Add ₹${Math.ceil(this.minOrderValue - subtotal)} more to use this coupon` };
  }
  return { ok: true };
};

module.exports = mongoose.model('Coupon', couponSchema);
