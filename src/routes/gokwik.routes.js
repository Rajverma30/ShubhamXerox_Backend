/**
 * The cart API GoKwik's servers call during checkout.
 *
 * Mounted OUTSIDE /api (see app.js) at two prefixes that answer identically:
 *
 *   /wp-json/gokwik/v1   the exact path GoKwik's WooCommerce integration calls
 *   /gokwik/v1           a plain alias, in case GoKwik prefers to register it
 *
 * health-check and process-refund carry no app headers in GoKwik's contract,
 * so they sit before the auth guard; process-refund verifies its own hmac.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');

const gokwikAuth = require('../middleware/gokwikAuth');
const cart = require('../controllers/gokwikCart.controller');

const router = express.Router();

/* GoKwik calls from a handful of server IPs and makes several requests per
   checkout, so this is deliberately looser than the storefront limiter. It
   only exists to stop someone hammering the unauthenticated endpoints. */
router.use(rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.GOKWIK_RATE_LIMIT) || 1200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 'rest_too_many_requests', message: 'Too many requests.', data: { status: 429 } },
}));

/* ── no app headers ── */
router.all('/cart/health-check', cart.healthCheck);
router.post('/cart/process-refund', cart.processRefund);

/* ── everything else needs the App ID + App Secret ── */
router.use(gokwikAuth);

router.post('/cart', cart.getCart);
router.get('/cart', cart.getCart);
router.get('/cart/get-coupons', cart.getCoupons);
router.post('/cart/get-coupons', cart.getCoupons);
router.post('/cart/apply-coupon', cart.applyCoupon);
router.post('/cart/remove-coupon', cart.removeCoupon);
router.post('/cart/set-address', cart.setAddress);
router.post('/cart/set-shipping-method', cart.setShippingMethod);
router.post('/cart/remove-out-of-stock-items', cart.removeOutOfStockItems);
router.post('/cart/get-wallet-balance', cart.getWalletBalance);
router.post('/cart/deduct-wallet-balance', cart.deductWalletBalance);
router.post('/cart/place-order', cart.placeOrder);
router.post('/cart/check-order-exists', cart.checkOrderExists);
router.post('/cart/update-order-status', cart.updateOrderStatus);

/* Unknown path or a crash: answer in the shape the caller parses, never HTML. */
router.use((req, res) =>
  res.status(404).json({ code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } }));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, _next) => {
  require('../utils/logger').error(`GoKwik cart API ${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
  res.status(500).json({ code: 'internal_server_error', message: 'Something went wrong.', data: { status: 500 } });
});

module.exports = router;
