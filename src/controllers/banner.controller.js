const { Banner } = require('../models');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/response');
const imageService = require('../services/image.service');

async function attach(files, target) {
  if (!files) return;
  const jobs = [];
  ['image', 'tabletImage', 'mobileImage'].forEach((field) => {
    if (files[field]?.[0]) {
      jobs.push(imageService.processImage(files[field][0].path, { folder: 'banners', alt: target.title || '' })
        .then((img) => { target[field] = img; }));
    }
  });
  await Promise.all(jobs);
}

const bool = (v) => v === true || String(v) === 'true';

function parse(body) {
  const out = { ...body };
  if (out.priority !== undefined) out.priority = Number(out.priority) || 0;
  if (out.overlayOpacity !== undefined) out.overlayOpacity = Number(out.overlayOpacity);
  if (out.isActive !== undefined) out.isActive = bool(out.isActive);
  ['startsAt', 'endsAt'].forEach((k) => { if (out[k] === '') out[k] = null; });
  ['category', 'subCategory'].forEach((k) => { if (out[k] === '') delete out[k]; });
  return out;
}

/** GET /api/banners?placement=hero */
exports.listPublic = asyncHandler(async (req, res) => {
  const query = Banner.liveQuery(req.query.placement);
  if (req.query.category) query.category = req.query.category;
  if (req.query.subCategory) query.subCategory = req.query.subCategory;

  const banners = await Banner.find(query).sort({ priority: -1, createdAt: -1 }).limit(Number(req.query.limit) || 12).lean();
  return ok(res, banners);
});

/** POST /api/banners/:id/click — CTR tracking. */
exports.trackClick = asyncHandler(async (req, res) => {
  await Banner.findByIdAndUpdate(req.params.id, { $inc: { clicks: 1 } });
  return ok(res, { tracked: true });
});

exports.adminList = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 30);
  const filter = {};
  if (req.query.placement) filter.placement = req.query.placement;
  if (req.query.isActive !== undefined && req.query.isActive !== '') filter.isActive = bool(req.query.isActive);

  const [items, total] = await Promise.all([
    Banner.find(filter).sort({ placement: 1, priority: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Banner.countDocuments(filter),
  ]);
  return paginated(res, items, { page, limit, total });
});

exports.adminGet = asyncHandler(async (req, res) => {
  const doc = await Banner.findById(req.params.id);
  if (!doc) throw ApiError.notFound('Banner not found');
  return ok(res, doc);
});

exports.adminCreate = asyncHandler(async (req, res) => {
  const body = parse(req.body);
  await attach(req.files, body);
  if (!body.image) throw ApiError.badRequest('A banner image is required');
  return created(res, await Banner.create(body));
});

exports.adminUpdate = asyncHandler(async (req, res) => {
  const doc = await Banner.findById(req.params.id);
  if (!doc) throw ApiError.notFound('Banner not found');
  const body = parse(req.body);
  await attach(req.files, body);
  Object.assign(doc, body);
  await doc.save();
  return ok(res, doc);
});

exports.adminDelete = asyncHandler(async (req, res) => {
  const doc = await Banner.findByIdAndDelete(req.params.id);
  if (!doc) throw ApiError.notFound('Banner not found');
  return ok(res, { message: 'Banner deleted' });
});
