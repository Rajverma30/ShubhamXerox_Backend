const mongoose = require('mongoose');

/**
 * One-time guest checkout session minted after OTP verify.
 * The JWT carries `jti`; this record is consumed when the first order is placed.
 */
const guestCheckoutSessionSchema = new mongoose.Schema(
  {
    jti: { type: String, required: true, unique: true, index: true },
    phone: { type: String, required: true, index: true },
    consumedAt: { type: Date, default: null },
    orderNumber: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

guestCheckoutSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('GuestCheckoutSession', guestCheckoutSessionSchema);
