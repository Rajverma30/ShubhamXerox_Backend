const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

/** 404 catch-all for unmatched routes. */
exports.notFound = (req, res, next) => next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));

/** Central error formatter — normalises Mongoose/JWT/Multer errors. */
exports.errorHandler = (err, req, res, _next) => {
  let error = err;

  /* Make sure the browser can READ this error.
     If an error is thrown before/around the cors middleware, the response goes
     out without Access-Control-Allow-Origin and Chrome reports a CORS failure
     instead of the real problem (413, 500, rate limit...). Re-attach here. */
  const origin = req.headers.origin;
  const allowed = req.app?.locals?.corsIsAllowed;
  if (origin && !res.getHeader('Access-Control-Allow-Origin') && (!allowed || allowed(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }

  if (err.name === 'CastError') error = ApiError.badRequest(`Invalid ${err.path}: ${err.value}`);
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    error = ApiError.conflict(`Duplicate value for "${field}"`);
  }
  if (err.name === 'ValidationError') {
    error = ApiError.unprocessable(
      'Validation failed',
      Object.values(err.errors).map((e) => ({ field: e.path, message: e.message })),
    );
  }
  if (err.name === 'JsonWebTokenError') error = ApiError.unauthorized('Invalid token');
  if (err.name === 'TokenExpiredError') error = ApiError.unauthorized('Session expired, please sign in again');
  if (err.code === 'LIMIT_FILE_SIZE') {
    error = ApiError.badRequest(
      `File is too large. The limit is ${process.env.MAX_IMAGE_MB || 8}MB for images ` +
      `and ${process.env.MAX_PDF_MB || 60}MB for PDFs (MAX_IMAGE_MB / MAX_PDF_MB in .env).`,
    );
  }
  // body-parser rejects oversized JSON bodies with this.
  if (err.type === 'entity.too.large') error = ApiError.badRequest('Request body is too large');
  // sharp is a native binary and is the usual casualty of a bad deploy.
  if (/sharp|libvips/i.test(err.message || '')) {
    logger.error('Image processing failed — reinstall sharp on this server: npm rebuild sharp --verbose');
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') error = ApiError.badRequest(`Unexpected upload field "${err.field}"`);

  // Raw axios failures (e.g. Shiprocket login) otherwise leak as
  // "Request failed with status code 403" with a confusing 500.
  if (err.isAxiosError && !(err instanceof ApiError) && error === err) {
    const status = err.response?.status;
    const payload = err.response?.data;
    const msg =
      (typeof payload === 'string' && payload.trim()) ||
      payload?.message ||
      payload?.error ||
      err.message ||
      'Upstream request failed';
    error = new ApiError(
      status && status < 500 ? 400 : 502,
      String(msg).slice(0, 400),
      payload && typeof payload === 'object' ? payload : undefined,
    );
  }

  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) logger.error(err.stack || err.message);

  res.status(statusCode).json({
    success: false,
    message: error.message || 'Something went wrong',
    ...(error.details ? { details: error.details } : {}),
    ...(process.env.NODE_ENV !== 'production' && statusCode >= 500 ? { stack: err.stack } : {}),
  });
};
