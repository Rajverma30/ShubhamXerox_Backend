const mongoose = require('mongoose');

/**
 * Server-side cart snapshot for GoKwik Checkout.
 *
 * The storefront only sends product ids/quantities. GoKwik's servers then call
 * our cart API with this session key (merchantCheckoutId) to read prices,
 * apply coupons, set the address and place the order.
 */
const itemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: 1, max: 99 },
  },
  { _id: false },
);

const checkoutSessionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    items: { type: [itemSchema], default: [] },
    coupons: { type: [String], default: [] },
    customer: { type: mongoose.Schema.Types.Mixed, default: {} },
    customerEmail: { type: String, default: '' },
    paymentMethod: { type: String, default: '' },
    shippingMethods: { type: [String], default: [] },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    orderNumber: { type: String, default: '' },
    // MongoDB TTL monitor removes abandoned sessions automatically.
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model('CheckoutSession', checkoutSessionSchema);
