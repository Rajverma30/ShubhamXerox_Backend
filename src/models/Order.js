const mongoose = require('mongoose');
const { addressSchema } = require('./_shared');

/**
 * A guest order.
 *
 * This store has no customer accounts. A phone number verified by OTP is the
 * only identity, captured on the order itself — so a returning customer is
 * just someone who verifies the same number again.
 *
 * Prepaid only: Razorpay collects the money before the order is confirmed.
 * There is no COD path anywhere in this model on purpose, so a future code
 * change cannot accidentally create an unpaid, shippable order.
 *
 * Fulfilment is manual. `status` is moved by an admin, and `tracking` is typed
 * in by hand once the parcel is handed to a courier.
 */
const orderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    /** Copied at purchase time. The catalogue changes; an order must not. */
    title: { type: String, required: true },
    slug: String,
    sku: String,
    image: String,
    price: { type: Number, required: true },   // per unit, what was charged
    mrp: { type: Number, default: 0 },
    quantity: { type: Number, required: true, min: 1 },
    lineTotal: { type: Number, required: true },
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, unique: true, index: true },

    /* ── who ── */
    customer: {
      name: { type: String, required: true, trim: true },
      /** Verified by OTP before this order could be created. */
      phone: { type: String, required: true, index: true },
      email: { type: String, default: '', trim: true },
    },
    shippingAddress: { type: addressSchema, required: true },

    /* ── what ── */
    items: { type: [orderItemSchema], required: true },

    /* ── money (rupees; Razorpay's paise conversion lives in its service) ── */
    subtotal: { type: Number, required: true },
    shippingCharge: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    couponCode: { type: String, default: '' },
    total: { type: Number, required: true },
    currency: { type: String, default: 'INR' },

    /* ── payment ── */
    payment: {
      provider: { type: String, default: 'razorpay' },
      razorpayOrderId: { type: String, index: true },
      razorpayPaymentId: { type: String, index: true },
      razorpaySignature: String,
      method: String,              // upi / card / netbanking …
      status: {
        type: String,
        enum: ['created', 'paid', 'failed', 'refunded'],
        default: 'created',
        index: true,
      },
      paidAt: Date,
      /** Razorpay's own amount, in paise, as reported back to us. */
      amountPaisa: Number,
    },

    /* ── fulfilment (manual) ── */
    status: {
      type: String,
      enum: ['awaiting-payment', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'],
      default: 'awaiting-payment',
      index: true,
    },
    tracking: {
      courier: { type: String, default: '' },
      awb: { type: String, default: '' },
      url: { type: String, default: '' },
      shippedAt: Date,
      deliveredAt: Date,
    },

    /* ── Shiprocket adhoc delivery integration ── */
    shiprocket: {
      orderId: String,
      shipmentId: String,
      awb: String,
      status: String,
      /** Digit-only id we sent to Shiprocket as order_id */
      channelOrderId: String,
      pushedAt: Date,
      error: String,
    },

    /** Set once, when payment first succeeds, so stock is never double-counted. */
    stockAdjusted: { type: Boolean, default: false },

    adminNotes: { type: String, default: '' },
    /** WhatsApp notification log */
    whatsappNotifications: {
      orderConfirmedSent: { type: Boolean, default: false },
      orderConfirmedSentAt: Date,
      awaitingPaymentSent: { type: Boolean, default: false },
      awaitingPaymentSentAt: Date,
      lastError: String,
    },
    /** Untouched provider payloads, for reconciling a disputed payment. */
    raw: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true },
);

orderSchema.index({ createdAt: -1 });
orderSchema.index({ 'customer.phone': 1, createdAt: -1 });

/** SX-YYMMDD-XXXXX. Generated before validation so `unique` can be enforced. */
orderSchema.pre('validate', function setNumber(next) {
  if (!this.orderNumber) {
    const d = new Date();
    const stamp = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
    this.orderNumber = `SX-${stamp}-${rand}`;
  }
  next();
});

module.exports = mongoose.model('Order', orderSchema);
