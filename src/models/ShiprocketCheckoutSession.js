const mongoose = require('mongoose');

/**
 * A short-lived server-side copy of a Fastrr / Shiprocket Checkout hand-off.
 *
 * The browser is never trusted with price or product metadata.  The session
 * lets the webhook turn a successful external checkout into a normal local
 * Order without having to reconstruct a cart from provider input.
 */
const itemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    title: { type: String, required: true },
    slug: String,
    sku: String,
    image: String,
    price: { type: Number, required: true },
    mrp: { type: Number, default: 0 },
    quantity: { type: Number, required: true, min: 1 },
    lineTotal: { type: Number, required: true },
  },
  { _id: false },
);

const shiprocketCheckoutSessionSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
    items: { type: [itemSchema], required: true },
    subtotal: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    sellerDomain: { type: String, required: true },
    status: { type: String, enum: ['initiated', 'paid', 'failed'], default: 'initiated', index: true },
    providerOrderId: { type: String, default: '' },
    customer: {
      name: { type: String, default: '' },
      phone: { type: String, default: '' },
      email: { type: String, default: '' },
    },
    shippingAddress: {
      address: { type: String, default: '' },
      address2: { type: String, default: '' },
      landmark: { type: String, default: '' },
      city: { type: String, default: '' },
      district: { type: String, default: '' },
      state: { type: String, default: '' },
      pincode: { type: String, default: '' },
      country: { type: String, default: 'India' },
    },
    raw: { type: mongoose.Schema.Types.Mixed },
    // MongoDB's TTL monitor removes abandoned sessions automatically.
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model('ShiprocketCheckoutSession', shiprocketCheckoutSessionSchema);
