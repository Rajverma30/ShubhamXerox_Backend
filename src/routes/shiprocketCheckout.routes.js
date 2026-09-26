/**
 * Shiprocket Checkout catalogue routes.
 *
 * Mounted in app.js at SHIPROCKET_CHECKOUT_ROUTE_PREFIX (default
 * "/shiprocket-checkout"), i.e. OUTSIDE the /api namespace, so the URLs match
 * exactly what the client registered with Shiprocket:
 *
 *   https://shubhamxerox.in/shiprocket-checkout/products
 *   https://shubhamxerox.in/shiprocket-checkout/collections
 *
 * Every route is behind the API-key/secret check.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');

const shiprocketCheckoutAuth = require('../middleware/shiprocketCheckoutAuth');
const ctrl = require('../controllers/shiprocketCheckout.controller');
const sessionCtrl = require('../controllers/shiprocketSession.controller');

const router = express.Router();

// Catalogue sync is bursty — allow far more than the storefront limiter,
// but still cap it so a misconfigured poller can't hammer the database.
const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Too many catalogue sync requests' },
});

// Provider payment webhooks and Fastrr browser checkout endpoints (shipping charge, cart validate, loyalty, order create)
// use their own signatures/public handshakes. Catalogue GETs below continue to require catalogue API credentials.
router.post('/webhook', sessionCtrl.webhook);
router.post('/order/create', sessionCtrl.webhook);
router.post('/order-create', sessionCtrl.webhook);
router.post('/orders/create', sessionCtrl.webhook);
router.post('/orders', sessionCtrl.webhook);
router.post('/order', sessionCtrl.webhook);

// Loyalty Points endpoints
router.post('/loyalty/points', ctrl.getLoyaltyPoints);
router.post('/loyalty-points', ctrl.getLoyaltyPoints);
router.post('/loyalty/block', ctrl.blockLoyaltyPoints);
router.post('/loyalty-block', ctrl.blockLoyaltyPoints);
router.post('/loyalty/unblock', ctrl.unblockLoyaltyPoints);
router.post('/loyalty-unblock', ctrl.unblockLoyaltyPoints);

// Custom Shipping & Cart Validation
router.post('/shipping-charge', ctrl.shippingCharge);
router.post('/shipping_charge', ctrl.shippingCharge);
router.post('/shipping', ctrl.shippingCharge);
router.post('/serviceability', ctrl.shippingCharge);

router.post('/cart/validate', ctrl.validateCart);
router.post('/cart-validate', ctrl.validateCart);
router.post('/validate', ctrl.validateCart);

router.post('/coupon/apply', ctrl.applyCoupon);
router.post('/coupon-apply', ctrl.applyCoupon);
router.post('/coupons/apply', ctrl.applyCoupon);

router.use(syncLimiter, shiprocketCheckoutAuth);

router.get('/ping', ctrl.ping);
router.get('/products', ctrl.products);      // also COLLECTION PRODUCT FETCH via ?collection_id=
router.get('/products/:productId', ctrl.singleProduct);
router.get('/collections', ctrl.collections);
router.get('/collections/:collectionId', ctrl.singleCollection);
router.get('/collections/:collectionId/products', ctrl.collectionProducts);

module.exports = router;
