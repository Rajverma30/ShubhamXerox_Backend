/**
 * Storefront API. Entirely public — there is no customer authentication.
 * Anything that mutates state is rate-limited and validated.
 */
const express = require('express');
const { body, param, query } = require('express-validator');

const validate = require('../middleware/validate');
const { writeLimiter } = require('../middleware/rateLimit');
const rateLimit = require('express-rate-limit');

const productCtrl = require('../controllers/product.controller');
const categoryCtrl = require('../controllers/category.controller');
const trackingCtrl = require('../controllers/tracking.controller');
const homeCtrl = require('../controllers/home.controller');
const bannerCtrl = require('../controllers/banner.controller');
const couponCtrl = require('../controllers/coupon.controller');
const contentCtrl = require('../controllers/content.controller');
const dashboardCtrl = require('../controllers/dashboard.controller');
const seoCtrl = require('../controllers/seo.controller');

const router = express.Router();

/* ── store config + homepage ── */
router.get('/settings', contentCtrl.getPublicSettings);

/* ── Guest checkout: OTP → address → Razorpay ────────────────────────────
   There are no customer accounts. A phone verified by OTP mints a 30-minute
   token that is only good for placing one order. */
const guestAuthCtrl = require('../controllers/guestAuth.controller');
const checkoutCtrl = require('../controllers/checkout.controller');
const shiprocketSessionCtrl = require('../controllers/shiprocketSession.controller');
const requireVerifiedPhone = require('../middleware/guestAuth');

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,                       // per IP; per-number limits live in the controller
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many verification attempts. Please try again later.' },
});

router.post('/auth/otp/send', otpLimiter, guestAuthCtrl.sendOtp);
router.post('/auth/otp/verify', otpLimiter, guestAuthCtrl.verifyOtp);
router.post('/auth/direct-session', writeLimiter, guestAuthCtrl.directSession);

router.post('/checkout/quote', writeLimiter, checkoutCtrl.quote);
router.post('/checkout/order', writeLimiter, requireVerifiedPhone, checkoutCtrl.createOrder);
router.post('/checkout/verify', requireVerifiedPhone, checkoutCtrl.verifyPayment);
router.post('/checkout/shiprocket-session', writeLimiter, shiprocketSessionCtrl.createSession);

/* Razorpay signs the raw body; unsigned calls are rejected in the handler. */
router.post('/webhooks/razorpay', checkoutCtrl.razorpayWebhook);

router.get('/orders/lookup/by-phone', checkoutCtrl.getOrdersByPhone);
router.get('/orders/:orderNumber', checkoutCtrl.getOrder);

router.get('/home', homeCtrl.home);
router.get('/banners', bannerCtrl.listPublic);
router.post('/banners/:id/click', bannerCtrl.trackClick);
router.post('/track', dashboardCtrl.track);

/* ── taxonomy ── */
router.get('/categories', categoryCtrl.listPublic);
router.get('/categories/:slug', categoryCtrl.getBySlug);
router.get('/subcategories', categoryCtrl.listSubCategoriesPublic);
router.get('/subcategories/:slug', categoryCtrl.getSubCategoryBySlug);

/* ── catalogue ── */
router.get('/products', productCtrl.list);
router.get('/products/facets', productCtrl.facets);

// Convenience views over the single Product collection.
router.get('/books', (req, res, next) => { req.query.type = 'book,book+ebook'; return productCtrl.list(req, res, next); });
router.get('/ebooks', (req, res, next) => { req.query.type = 'ebook,book+ebook'; return productCtrl.list(req, res, next); });
router.get('/stationery', (req, res, next) => { req.query.type = 'stationery'; return productCtrl.list(req, res, next); });

router.get('/products/:slug', productCtrl.getBySlug);
router.get('/products/:slug/preview', productCtrl.preview);
router.get('/products/:slug/ebook', productCtrl.downloadEbook);
router.get('/og/product/:slug', seoCtrl.productOg);
router.get('/og/image/:slug', seoCtrl.productOgImage);
router.get('/og/image/:slug.jpg', seoCtrl.productOgImage);

router.post(
  '/products/:slug/reviews',
  writeLimiter,
  [
    param('slug').isString(),
    body('name').trim().isLength({ min: 2 }).withMessage('Name is required'),
    body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be 1–5'),
    body('email').optional({ values: 'falsy' }).isEmail().withMessage('Enter a valid email'),
  ],
  validate,
  contentCtrl.createReview,
);

/* ── search ── */
router.get('/search/suggest', [query('q').optional().isString()], validate, productCtrl.suggest);
router.get('/search/popular', productCtrl.popularSearches);

/* ── coupons & shipping ── */
router.get('/coupons', couponCtrl.listPublic);
router.get('/shipping/serviceability', trackingCtrl.serviceability);

/* ── order tracking (proxied live to Shiprocket) ── */
router.get('/track', trackingCtrl.track);

/* ── forms ── */
router.post('/newsletter', writeLimiter, [body('email').isEmail()], validate, contentCtrl.subscribe);
router.post('/newsletter/unsubscribe', [body('email').isEmail()], validate, contentCtrl.unsubscribe);
router.post(
  '/contact',
  writeLimiter,
  [
    body('name').trim().isLength({ min: 2 }),
    body('email').isEmail(),
    body('message').trim().isLength({ min: 5 }).withMessage('Tell us a little more'),
  ],
  validate,
  contentCtrl.createContact,
);

/* ── SEO & Legacy ── */
const legacyCtrl = require('../controllers/legacy.controller');
router.get('/legacy/resolve', legacyCtrl.resolve);
router.get('/seo/product/:slug', seoCtrl.productSchema);

module.exports = router;
