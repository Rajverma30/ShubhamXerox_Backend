/**
 * Admin API. Everything except /auth/login sits behind `protectAdmin`.
 * There is deliberately no registration endpoint — the single admin account
 * is created by the seed script and editable from the panel.
 */
const express = require('express');
const { body } = require('express-validator');

const { protectAdmin } = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rateLimit');
const validate = require('../middleware/validate');
const { productUpload, taxonomyUpload, bannerUpload, mediaUpload } = require('../middleware/upload');

const authCtrl = require('../controllers/auth.controller');
const productCtrl = require('../controllers/product.controller');
const categoryCtrl = require('../controllers/category.controller');
const bannerCtrl = require('../controllers/banner.controller');
const couponCtrl = require('../controllers/coupon.controller');
const homeCtrl = require('../controllers/home.controller');
const contentCtrl = require('../controllers/content.controller');
const dashboardCtrl = require('../controllers/dashboard.controller');
const shiprocketSessionCtrl = require('../controllers/shiprocketSession.controller');

const router = express.Router();

/* ── auth ── */
router.post(
  '/auth/login',
  loginLimiter,
  [body('username').trim().notEmpty().withMessage('Username is required'), body('password').notEmpty().withMessage('Password is required')],
  validate,
  authCtrl.login,
);

router.use(protectAdmin); // everything below requires a valid admin JWT

router.get('/auth/me', authCtrl.me);
router.post('/auth/logout', authCtrl.logout);
router.put('/auth/profile', authCtrl.updateProfile);
router.put(
  '/auth/password',
  [body('currentPassword').notEmpty(), body('newPassword').isLength({ min: 12 }).withMessage('Use at least 12 characters')],
  validate,
  authCtrl.changePassword,
);

/* ── dashboard ── */
router.get('/dashboard', dashboardCtrl.stats);

/* ── categories ── */
router.get('/categories', categoryCtrl.adminList);
router.post('/categories/reorder', categoryCtrl.adminReorder);
router.post('/categories', taxonomyUpload, [body('name').trim().notEmpty()], validate, categoryCtrl.adminCreate);
router.get('/categories/:id', categoryCtrl.adminGet);
router.put('/categories/:id', taxonomyUpload, categoryCtrl.adminUpdate);
router.delete('/categories/:id', categoryCtrl.adminDelete);

/* ── subcategories ── */
router.get('/subcategories', categoryCtrl.adminListSub);
router.post('/subcategories', taxonomyUpload, [body('name').trim().notEmpty(), body('category').notEmpty()], validate, categoryCtrl.adminCreateSub);
router.get('/subcategories/:id', categoryCtrl.adminGetSub);
router.put('/subcategories/:id', taxonomyUpload, categoryCtrl.adminUpdateSub);
router.delete('/subcategories/:id', categoryCtrl.adminDeleteSub);

/* ── orders (guest checkout, Razorpay; fulfilment is manual) ── */
const orderCtrl = require('../controllers/checkout.controller');
router.get('/orders', orderCtrl.adminListOrders);
router.get('/orders/:id', orderCtrl.adminGetOrder);
router.patch('/orders/:id', orderCtrl.adminUpdateOrder);
router.post('/orders/:id/sync-payment', orderCtrl.adminSyncPayment);
router.post('/orders/:id/whatsapp', orderCtrl.adminSendWhatsApp);
router.post('/orders/:id/push-shiprocket', orderCtrl.adminPushToShiprocket);
router.get('/shiprocket/status', orderCtrl.adminShiprocketStatus);


/* ── products (books / ebooks / stationery) ── */
router.get('/products', productCtrl.adminList);
router.get('/products/suggestions', productCtrl.adminSuggestions);
router.post('/products/bulk', productCtrl.adminBulk);
router.post(
  '/products',
  productUpload,
  [body('title').trim().notEmpty().withMessage('Title is required'), body('price').isNumeric().withMessage('Price is required'), body('category').notEmpty().withMessage('Category is required')],
  validate,
  productCtrl.adminCreate,
);
router.get('/products/:id', productCtrl.adminGet);
router.put('/products/:id', productUpload, productCtrl.adminUpdate);
router.patch('/products/:id/flags', productCtrl.adminToggleFlags);
router.post('/products/:id/regenerate-images', productCtrl.adminRegenerateImages);
router.delete('/products/:id', productCtrl.adminDelete);

/* ── banners ── */
router.get('/banners', bannerCtrl.adminList);
router.post('/banners', bannerUpload, bannerCtrl.adminCreate);
router.get('/banners/:id', bannerCtrl.adminGet);
router.put('/banners/:id', bannerUpload, bannerCtrl.adminUpdate);
router.delete('/banners/:id', bannerCtrl.adminDelete);

/* ── coupons / offers ── */
router.get('/coupons', couponCtrl.adminList);
router.post('/coupons', [body('code').trim().notEmpty()], validate, couponCtrl.adminCreate);
router.put('/coupons/:id', couponCtrl.adminUpdate);
router.delete('/coupons/:id', couponCtrl.adminDelete);

/* ── homepage builder ── */
router.get('/home-sections', homeCtrl.adminList);
router.post('/home-sections', homeCtrl.adminCreate);
router.post('/home-sections/reorder', homeCtrl.adminReorder);
router.put('/home-sections/:id', homeCtrl.adminUpdate);
router.delete('/home-sections/:id', homeCtrl.adminDelete);

/* ── settings & SEO ── */
router.get('/settings', contentCtrl.adminGetSettings);
router.put('/settings', contentCtrl.adminUpdateSettings);
router.get('/shiprocket/diagnostics', shiprocketSessionCtrl.diagnostics);
router.post('/shiprocket/resync-catalogue', shiprocketSessionCtrl.resyncCatalogue);

/* ── media library ── */
router.get('/media', contentCtrl.adminListMedia);
router.post('/media', mediaUpload, contentCtrl.adminUploadMedia);
router.put('/media/:id', contentCtrl.adminUpdateMedia);
router.delete('/media/:id', contentCtrl.adminDeleteMedia);

/* ── reviews ── */
router.get('/reviews', contentCtrl.adminListReviews);
router.patch('/reviews/:id', contentCtrl.adminModerateReview);
router.delete('/reviews/:id', contentCtrl.adminDeleteReview);

/* ── newsletter & contact ── */
router.get('/newsletter', contentCtrl.adminListNewsletter);
router.get('/contacts', contentCtrl.adminListContacts);
router.put('/contacts/:id', contentCtrl.adminUpdateContact);

module.exports = router;
