const { Coupon } = require('../models');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/response');

/** GET /api/coupons — publicly advertised offers. */
exports.listPublic = asyncHandler(async (_req, res) => {
  const now = new Date();
  const coupons = await Coupon.find({
    isActive: true,
    showOnSite: true,
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ expiresAt: null }, { expiresAt: { $gte: now } }] },
    ],
  })
    .select('code description type value minOrderValue maxDiscount expiresAt')
    .sort({ value: -1 })
    .lean();
  return ok(res, coupons);
});

exports.adminList = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 30);
  const filter = req.query.search ? { code: new RegExp(req.query.search, 'i') } : {};
  const [items, total] = await Promise.all([
    Coupon.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Coupon.countDocuments(filter),
  ]);
  return paginated(res, items, { page, limit, total });
});

exports.adminCreate = asyncHandler(async (req, res) => created(res, await Coupon.create(req.body)));

exports.adminUpdate = asyncHandler(async (req, res) => {
  const doc = await Coupon.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!doc) throw ApiError.notFound('Coupon not found');
  return ok(res, doc);
});

exports.adminDelete = asyncHandler(async (req, res) => {
  const doc = await Coupon.findByIdAndDelete(req.params.id);
  if (!doc) throw ApiError.notFound('Coupon not found');
  return ok(res, { message: 'Coupon deleted' });
});
