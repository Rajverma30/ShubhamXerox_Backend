/**
 * Multer storage for images, PDFs (book preview source) and ebooks.
 * Files land in uploads/tmp and are post-processed by services/image.service
 * or services/pdf.service, then moved to their final folder.
 */
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const ApiError = require('../utils/ApiError');

const ROOT = path.join(__dirname, '..', '..', process.env.UPLOAD_DIR || 'uploads');
const TMP = path.join(ROOT, 'tmp');

['products', 'pdf', 'ebooks', 'banners', 'media', 'tmp'].forEach((d) => {
  fs.mkdirSync(path.join(ROOT, d), { recursive: true });
});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TMP),
  filename: (_req, file, cb) => {
    const safe = path
      .basename(file.originalname, path.extname(file.originalname))
      .replace(/[^a-zA-Z0-9-_]/g, '-')
      .slice(0, 48);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}-${safe}${path.extname(file.originalname).toLowerCase()}`);
  },
});

const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/svg+xml'];
const PDF_FIELDS = new Set(['pdf', 'ebook', 'preview']);

function fileFilter(_req, file, cb) {
  const isImageField = ['images', 'image', 'banner', 'icon', 'thumbnail', 'files', 'tabletImage', 'mobileImage'].includes(file.fieldname);
  const isPdfField = PDF_FIELDS.has(file.fieldname);

  if (isImageField && IMAGE_MIME.includes(file.mimetype)) return cb(null, true);
  if (isPdfField && file.mimetype === 'application/pdf') return cb(null, true);

  return cb(ApiError.badRequest(`Unsupported file "${file.originalname}" for field "${file.fieldname}"`));
}

const maxImage = (Number(process.env.MAX_IMAGE_MB) || 8) * 1024 * 1024;
const maxPdf = (Number(process.env.MAX_PDF_MB) || 60) * 1024 * 1024;

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: maxPdf, files: 24 },
});

function removeFile(filePath) {
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}

/** Reject files that exceed per-field limits (images vs PDFs). */
function enforceFieldSizeLimits(req, _res, next) {
  const groups = req.files || {};
  const flat = Array.isArray(groups) ? groups : Object.values(groups).flat();

  for (const file of flat) {
    const limit = PDF_FIELDS.has(file.fieldname) ? maxPdf : maxImage;
    if (file.size > limit) {
      removeFile(file.path);
      const mb = PDF_FIELDS.has(file.fieldname) ? process.env.MAX_PDF_MB || 60 : process.env.MAX_IMAGE_MB || 8;
      return next(ApiError.badRequest(`"${file.originalname}" is too large. Max ${mb}MB for ${file.fieldname}.`));
    }
  }
  return next();
}

function withSizeLimits(middleware) {
  return (req, res, next) => middleware(req, res, (err) => {
    if (err) return next(err);
    return enforceFieldSizeLimits(req, res, next);
  });
}

module.exports = {
  upload,
  ROOT,
  TMP,
  enforceFieldSizeLimits,
  /** Product form: many images + optional source PDF + optional free ebook PDF. */
  productUpload: withSizeLimits(upload.fields([
    { name: 'images', maxCount: 12 },
    { name: 'pdf', maxCount: 1 },
    { name: 'ebook', maxCount: 1 },
  ])),
  /** Category / subcategory: square image + wide banner + icon. */
  taxonomyUpload: withSizeLimits(upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'banner', maxCount: 1 },
    { name: 'icon', maxCount: 1 },
  ])),
  bannerUpload: withSizeLimits(upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'tabletImage', maxCount: 1 },
    { name: 'mobileImage', maxCount: 1 },
  ])),
  mediaUpload: withSizeLimits(upload.array('files', 20)),
};
