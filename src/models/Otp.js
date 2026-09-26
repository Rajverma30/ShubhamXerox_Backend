const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * One-time passcodes for guest checkout.
 *
 * There are no customer accounts on this store — a verified phone number IS
 * the identity, and only for the few minutes it takes to place an order.
 *
 * The code is stored as a SHA-256 hash. If the database is ever dumped, a
 * leaked collection of live OTPs would let someone complete a stranger's
 * checkout, and hashing costs nothing here.
 *
 * `expiresAt` carries a TTL index, so Mongo deletes rows itself and the
 * collection cannot grow without bound.
 */
const otpSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true },
    codeHash: { type: String, required: true },

    /** Wrong guesses. Five strikes and this code is dead. */
    attempts: { type: Number, default: 0 },
    /** Set on success so a code cannot be replayed. */
    consumedAt: Date,

    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    ip: String,
  },
  { timestamps: true },
);

otpSchema.statics.hash = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

module.exports = mongoose.model('Otp', otpSchema);
