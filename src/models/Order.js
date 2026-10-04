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
    /** Numeric product id GoKwik expects (derived from Mongo ObjectId). */
    variantId: Number,
  },
  { _id: false },
);

/**
 * Explicit sub-schema so a field named `type` (GoKwik PREPAID / COD) is not
 * mistaken by Mongoose for SchemaType options — that bug made `order.payment`
 * undefined and broke Razorpay (`Cannot set … razorpayOrderId`).
 */
const paymentSchema = new mongoose.Schema(
  {
    provider: { type: String, default: 'razorpay' },
    razorpayOrderId: { type: String, index: true },
    razorpayPaymentId: { type: String, index: true },
    razorpaySignature: String,
    /** GoKwik order id (also used as platformOrderId). Indexed sparsely below. */
    orderId: { type: String },
    platformOrderId: String,
    /** PREPAID | CASH_ON_DELIVERY (GoKwik). */
    type: String,
    method: String,              // upi / card / netbanking …
    status: {
      type: String,
      enum: ['created', 'pending', 'paid', 'failed', 'refunded'],
      default: 'created',
      index: true,
    },
    checkoutStatus: String,
    transactionId: String,
    paidAt: Date,
    /** Razorpay's own amount, in paise, as reported back to us. */
    amountPaisa: Number,
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
    // required for Razorpay/Shiprocket; optional for all-digital GoKwik orders
    shippingAddress: { type: addressSchema, required: false },
    billingAddress: { type: addressSchema, required: false },

    /* ── what ── */
    items: { type: [orderItemSchema], required: true },

    /* ── money (rupees; Razorpay's paise conversion lives in its service) ── */
    subtotal: { type: Number, required: true },
    shippingCharge: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    couponCode: { type: String, default: '' },
    /** GoKwik may apply more than one coupon code over the session lifetime. */
    couponCodes: { type: [String], default: undefined },
    couponDiscount: { type: Number, default: undefined },
    prepaidDiscount: { type: Number, default: undefined },
    codCharges: { type: Number, default: undefined },
    fees: { type: [{ name: String, total: Number }], default: undefined },
    total: { type: Number, required: true },
    currency: { type: String, default: 'INR' },

    /** GoKwik CheckoutSession.key — used for idempotent place-order retries. */
    sessionKey: { type: String, index: true, sparse: true },

    /* ── payment ── */
    payment: { type: paymentSchema, default: () => ({}) },

    /* ── fulfilment (manual) ── */
    status: {
      type: String,
      enum: ['awaiting-payment', 'pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'failed'],
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

    /** Attribution / UTM source from GoKwik meta when present. */
    source: { type: String, default: '' },

    /** GoKwik refund webhook audit trail. */
    refunds: {
      type: [{
        refundId: String,
        amount: Number,
        event: String,
        at: Date,
      }],
      default: undefined,
    },

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
/** Sparse unique: GoKwik place-order retries must not create duplicate orders. */
orderSchema.index({ 'payment.orderId': 1 }, { unique: true, sparse: true });

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
