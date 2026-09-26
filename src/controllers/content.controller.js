/** Settings, media library, reviews, newsletter, contact — the "content" surface. */
const fs = require('fs/promises');
const path = require('path');
const { Setting, Media, Review, Newsletter, Contact, Product } = require('../models');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/response');
const imageService = require('../services/image.service');
const mail = require('../services/email.service');
const { cleanRichText, cleanText } = require('../utils/sanitize');

/* ───────────────────────── settings ───────────────────────── */

/** GET /api/settings — public store config consumed on app boot. */
exports.getPublicSettings = asyncHandler(async (_req, res) => {
  const s = await Setting.getSingleton();
  return ok(res, {
    storeName: s.storeName,
    tagline: s.tagline,
    logo: s.logo,
    favicon: s.favicon,
    email: s.email,
    phone: s.phone,
    whatsapp: s.whatsapp,
    address: s.address,
    mapEmbedUrl: s.mapEmbedUrl,
    openingHours: s.openingHours,
    social: s.social,
    currency: s.currency,
    currencySymbol: s.currencySymbol,
    taxPercent: s.taxPercent,
    shippingFlat: s.shippingFlat,
    freeShippingAbove: s.freeShippingAbove,
    codEnabled: s.codEnabled,
    prepaidEnabled: s.prepaidEnabled,
    minOrderValue: s.minOrderValue,
    announcementBar: s.announcementBar,
    testimonials: s.testimonials,
    footerLinks: s.footerLinks,
    policies: s.policies,
    popularSearches: s.popularSearches,
    // Drives the storefront hand-off (src/lib/shiprocketCheckout.js).
    checkout: s.checkout,
    seo: s.seo,
    maintenanceMode: s.maintenanceMode,
    googleAnalyticsId: s.googleAnalyticsId,
    facebookPixelId: s.facebookPixelId,
  });
});

exports.adminGetSettings = asyncHandler(async (_req, res) => ok(res, await Setting.getSingleton()));

exports.adminUpdateSettings = asyncHandler(async (req, res) => {
  const s = await Setting.getSingleton();
  const body = { ...req.body };
  if (body.policies) {
    Object.keys(body.policies).forEach((k) => { body.policies[k] = cleanRichText(body.policies[k]); });
  }
  delete body.singleton;
  if (body.checkout?.mode && !['razorpay', 'shiprocket'].includes(body.checkout.mode)) {
    body.checkout.mode = 'razorpay';
  }
  Object.assign(s, body);
  s.markModified('checkout');
  s.markModified('policies');
  s.markModified('seo');
  s.markModified('social');
  await s.save();
  return ok(res, s);
});

/* ───────────────────────── media library ───────────────────────── */

exports.adminListMedia = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 40);
  const filter = {};
  if (req.query.folder) filter.folder = req.query.folder;
  if (req.query.search) filter.originalName = new RegExp(req.query.search, 'i');

  const [items, total] = await Promise.all([
    Media.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Media.countDocuments(filter),
  ]);
  return paginated(res, items, { page, limit, total });
});

/** POST /api/admin/media — drag & drop multi-upload. */
exports.adminUploadMedia = asyncHandler(async (req, res) => {
  if (!req.files?.length) throw ApiError.badRequest('No files received');
  const folder = ['products', 'banners', 'categories', 'ebooks', 'misc'].includes(req.body.folder) ? req.body.folder : 'misc';

  const docs = await Promise.all(
    req.files.map(async (file) => {
      const img = await imageService.processImage(file.path, { folder: 'media', alt: req.body.alt || '' });
      return Media.create({
        ...img,
        filename: path.basename(img.url),
        originalName: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        folder,
      });
    }),
  );
  return created(res, docs);
});

exports.adminUpdateMedia = asyncHandler(async (req, res) => {
  const doc = await Media.findByIdAndUpdate(req.params.id, { alt: req.body.alt, tags: req.body.tags, folder: req.body.folder }, { new: true });
  if (!doc) throw ApiError.notFound('Media not found');
  return ok(res, doc);
});

exports.adminDeleteMedia = asyncHandler(async (req, res) => {
  const doc = await Media.findByIdAndDelete(req.params.id);
  if (!doc) throw ApiError.notFound('Media not found');
  // Best-effort local cleanup.
  if (doc.filename) {
    const base = path.join(__dirname, '..', '..', process.env.UPLOAD_DIR || 'uploads', 'media');
    await Promise.all(
      [doc.filename, doc.filename.replace('-full', '-card'), doc.filename.replace('-full', '-thumb')]
        .map((f) => fs.unlink(path.join(base, f)).catch(() => {})),
    );
  }
  return ok(res, { message: 'Media deleted' });
});

/* ───────────────────────── reviews ───────────────────────── */

/** POST /api/products/:slug/reviews — guest review submission. */
exports.createReview = asyncHandler(async (req, res) => {
  const product = await Product.findOne({ slug: req.params.slug }).select('_id');
  if (!product) throw ApiError.notFound('Product not found');

  // Orders live in Shiprocket, not here, so we can't verify a purchase
  // server-side. The order number is still recorded for manual checking
  // during moderation.
  const isVerifiedPurchase = false;

  const review = await Review.create({
    product: product._id,
    name: cleanText(req.body.name),
    email: req.body.email,
    rating: Number(req.body.rating),
    title: cleanText(req.body.title || ''),
    comment: cleanText(req.body.comment || ''),
    orderNumber: req.body.orderNumber,
    guestId: req.body.guestId,
    isVerifiedPurchase,
    isApproved: false,
  });
  return created(res, { message: 'Thanks! Your review will appear once approved.', id: review._id });
});

exports.adminListReviews = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 30);
  const filter = {};
  if (req.query.isApproved !== undefined && req.query.isApproved !== '') filter.isApproved = req.query.isApproved === 'true';

  const [items, total] = await Promise.all([
    Review.find(filter).populate('product', 'title slug images').sort({ createdAt: -1 })
      .skip((page - 1) * limit).limit(limit).lean(),
    Review.countDocuments(filter),
  ]);
  return paginated(res, items, { page, limit, total });
});

exports.adminModerateReview = asyncHandler(async (req, res) => {
  const doc = await Review.findByIdAndUpdate(req.params.id, { isApproved: req.body.isApproved === true || req.body.isApproved === 'true' }, { new: true });
  if (!doc) throw ApiError.notFound('Review not found');
  await Review.recalculate(doc.product);
  return ok(res, doc);
});

exports.adminDeleteReview = asyncHandler(async (req, res) => {
  const doc = await Review.findOneAndDelete({ _id: req.params.id });
  if (!doc) throw ApiError.notFound('Review not found');
  return ok(res, { message: 'Review deleted' });
});

/* ───────────────────────── newsletter ───────────────────────── */

exports.subscribe = asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw ApiError.badRequest('Enter a valid email address');
  await Newsletter.findOneAndUpdate(
    { email },
    { $set: { isSubscribed: true, name: req.body.name, source: req.body.source || 'footer', unsubscribedAt: null } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return created(res, { message: "You're subscribed. Watch out for our next drop!" });
});

exports.unsubscribe = asyncHandler(async (req, res) => {
  await Newsletter.findOneAndUpdate({ email: String(req.body.email).toLowerCase() }, { isSubscribed: false, unsubscribedAt: new Date() });
  return ok(res, { message: 'You have been unsubscribed' });
});

exports.adminListNewsletter = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(500, Number(req.query.limit) || 50);
  const [items, total] = await Promise.all([
    Newsletter.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Newsletter.countDocuments(),
  ]);
  return paginated(res, items, { page, limit, total });
});

/* ───────────────────────── contact ───────────────────────── */

exports.createContact = asyncHandler(async (req, res) => {
  const doc = await Contact.create({
    name: cleanText(req.body.name),
    email: req.body.email,
    phone: req.body.phone,
    subject: cleanText(req.body.subject || ''),
    message: cleanText(req.body.message),
    ip: req.ip,
  });
  mail.sendContactNotification(doc).catch(() => {});
  return created(res, { message: "Thanks for reaching out — we'll reply shortly." });
});

exports.adminListContacts = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 30);
  const filter = req.query.status ? { status: req.query.status } : {};
  const [items, total] = await Promise.all([
    Contact.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Contact.countDocuments(filter),
  ]);
  return paginated(res, items, { page, limit, total });
});

exports.adminUpdateContact = asyncHandler(async (req, res) => {
  const doc = await Contact.findByIdAndUpdate(
    req.params.id,
    { status: req.body.status, adminReply: req.body.adminReply, repliedAt: req.body.adminReply ? new Date() : undefined },
    { new: true },
  );
  if (!doc) throw ApiError.notFound('Message not found');
  if (req.body.adminReply) {
    mail.send({ to: doc.email, subject: `Re: ${doc.subject || 'Your enquiry'}`, html: `<p>${req.body.adminReply}</p>` }).catch(() => {});
  }
  return ok(res, doc);
});
