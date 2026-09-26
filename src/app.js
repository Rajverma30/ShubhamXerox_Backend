/**
 * Express application factory.
 * Security → parsing → static → routes → error handling.
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');

const logger = require('./utils/logger');
const routes = require('./routes');
const seoCtrl = require('./controllers/seo.controller');
const { apiLimiter } = require('./middleware/rateLimit');
const { notFound, errorHandler } = require('./middleware/error');

const app = express();

/* ── behind a proxy (nginx / render / railway) ── */
app.set('trust proxy', 1);
app.disable('x-powered-by');

/* ── security headers ── */
app.use(
  helmet({
    // Uploaded images are served from this origin and embedded on other origins.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
  }),
);

/* ── CORS ───────────────────────────────────────────────────────────────────
   Origins are configuration, NOT code. Add a domain by editing .env and
   restarting — never by editing this file.

     CORS_ORIGINS=https://newdomain.in,https://www.newdomain.in

   Wildcards are supported for subdomains:  CORS_ORIGINS=*.newdomain.in
   (that matches https://shop.newdomain.in but NOT https://newdomain.in —
   list the bare domain too if you need it).

   FRONTEND_URL and ADMIN_URL are always allowed, so a normal single-domain
   setup needs nothing here.
─────────────────────────────────────────────────────────────────────────── */
const clean = (u) => String(u || '').trim().replace(/\/$/, '');

const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.ADMIN_URL,
  ...String(process.env.CORS_ORIGINS || '').split(','),
  // Local dev servers (Vite): storefront 5173, admin 5174.
  ...(process.env.NODE_ENV === 'production' && process.env.CORS_ALLOW_LOCALHOST !== 'true'
    ? []
    : ['http://localhost:5173', 'http://localhost:5174', 'http://127.0.0.1:5173', 'http://127.0.0.1:5174']),
]
  .map(clean)
  .filter(Boolean);

/** Split into exact origins and *.domain patterns. */
const exactOrigins = new Set(allowedOrigins.filter((o) => !o.includes('*')));
const wildcardHosts = allowedOrigins
  .filter((o) => o.includes('*'))
  .map((o) => o.replace(/^https?:\/\//, '').replace(/^\*\./, '').toLowerCase());

function isAllowed(origin) {
  const o = clean(origin);
  if (exactOrigins.has(o)) return true;
  if (!wildcardHosts.length) return false;
  let host;
  try { host = new URL(o).hostname.toLowerCase(); } catch { return false; }
  return wildcardHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

const corsOptions = {
  origin(origin, cb) {
    // No Origin header = same-origin, curl, or server-to-server. Always fine.
    if (!origin) return cb(null, true);
    if (String(process.env.CORS_ALLOW_ALL).toLowerCase() === 'true') return cb(null, true);
    if (isAllowed(origin)) return cb(null, true);

    // A blocked origin is the single most common cause of "the site loads but
    // nothing works" — the browser only reports a generic CORS failure, so log
    // the actual origin and the allow-list to make it diagnosable.
    logger.warn(
      `CORS blocked "${origin}". Allowed: ${allowedOrigins.join(', ') || '(none)'}. ` +
      'Add it to CORS_ORIGINS in .env and restart.',
    );
    return cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  /* Reflect whatever headers the browser asks for in the preflight.
     A fixed list is a trap: the storefront sends x-guest-id, and any new
     custom header would silently break the site with
     "Request header field <x> is not allowed by Access-Control-Allow-Headers".
     Reflecting is safe — the ORIGIN allow-list above is what actually guards
     the API; headers alone grant no access.
     Set CORS_ALLOW_HEADERS in .env only if you need to pin an exact list. */
  allowedHeaders: process.env.CORS_ALLOW_HEADERS
    ? process.env.CORS_ALLOW_HEADERS.split(',').map((h) => h.trim()).filter(Boolean)
    : undefined,
  exposedHeaders: ['Content-Disposition', 'RateLimit-Limit', 'RateLimit-Remaining'],
  optionsSuccessStatus: 204,
  maxAge: 86400,
};

app.use(cors(corsOptions));
// Answer preflights here, before the rate limiter or auth can reject them.
// A rejected OPTIONS carries no CORS headers, which the browser reports as a
// confusing "No 'Access-Control-Allow-Origin' header" error.
app.options('*', cors(corsOptions));

logger.info(`CORS allow-list: ${allowedOrigins.join(', ') || '(empty — set FRONTEND_URL / ADMIN_URL)'}`);

// Shared with the error handler so failure responses (500 / 413 / 429) still
// carry CORS headers. Without this a real server error reaches the browser as
// "No 'Access-Control-Allow-Origin' header", hiding the actual cause.
app.locals.corsIsAllowed = isAllowed;

/* ── parsing ── */
app.use(
  express.json({
    limit: '2mb',
    // Keep the raw body around so Shiprocket Checkout's HMAC signature (if it
    // sends one) can be verified against the exact bytes we received.
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }),
);
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());
app.use(mongoSanitize());
app.use(hpp());
app.use(compression());

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

/* ── static uploads (long cache, immutable filenames) ── */
const fs = require('fs');

const uploadSearchDirs = [
  path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads', 'products'),
  path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads'),
  path.join(__dirname, '..', '..', 'uploads'),
];

const uploadsRoot = path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');
const uploadsFallbackHost = (process.env.UPLOADS_FALLBACK_ORIGIN || 'https://subhamxerox-nxt.web.app').replace(/\/$/, '');

function sendUploadOrFallback(req, res, next, { redirectPrefix = '/uploads' } = {}) {
  const filename = path.basename(req.path);
  if (!filename || filename === '/' || filename === '.') return next();

  // Prefer exact relative path under uploads root (products/…, media/…)
  const rel = req.path.replace(/^\/+/, '');
  const direct = path.join(uploadsRoot, rel);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
    return res.sendFile(direct, { maxAge: '30d', immutable: true });
  }

  for (const dir of uploadSearchDirs) {
    const filePath = path.join(dir, filename);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return res.sendFile(filePath, { maxAge: '30d', immutable: true });
    }
  }

  // Optional CDN / Firebase fallback when a file is not on this instance's disk.
  const fallbackRel = req.path.startsWith('/') ? req.path : `/${req.path}`;
  return res.redirect(302, `${uploadsFallbackHost}${redirectPrefix}${fallbackRel}`);
}

app.use(
  '/uploads',
  express.static(uploadsRoot, {
    maxAge: '30d',
    etag: true,
    immutable: true,
  }),
);

app.use('/uploads', (req, res, next) => sendUploadOrFallback(req, res, next, { redirectPrefix: '/uploads' }));

/* /img — alias of /uploads for catalogue media URLs */
app.use(
  '/img',
  express.static(uploadsRoot, {
    maxAge: '30d',
    etag: true,
    immutable: true,
  }),
);
app.use('/img', (req, res, next) => sendUploadOrFallback(req, res, next, { redirectPrefix: '/uploads' }));

/* ── health ── */
app.get('/health', (_req, res) =>
  res.json({ success: true, service: 'subham-backend', uptime: process.uptime(), env: process.env.NODE_ENV || 'development' }),
);

/* ── legacy URL redirects (opt-in: LEGACY_REDIRECT=true) ──
   Old product links 301 to their new /product/<slug>. Sits before the API so
   it can catch bare paths, and it explicitly skips /api, /uploads and /health. */
app.use(require('./controllers/legacy.controller').redirectMiddleware);

/* ── SEO files (also proxied by the storefront) ── */
app.get('/sitemap.xml', seoCtrl.sitemap);
app.get('/robots.txt', seoCtrl.robots);
app.get('/googlec4a4735a45ba64b1.html', (_req, res) => res.type('text/plain').send('google-site-verification: googlec4a4735a45ba64b1.html'));

/* ── Shiprocket Checkout catalogue endpoints ──
   Mounted outside /api so the paths match the URLs registered with Shiprocket
   (e.g. https://shubhamxerox.in/shiprocket-checkout/products). Disabled unless
   credentials are present, so it can never be left open by accident. */
const SR_PREFIX = process.env.SHIPROCKET_CHECKOUT_ROUTE_PREFIX || '/shiprocket-checkout';
app.use(SR_PREFIX, require('./routes/shiprocketCheckout.routes'));
logger.info(`Shiprocket Checkout endpoints mounted at ${SR_PREFIX}`);

/* ── API ── */
app.use('/api', apiLimiter, routes);

/* ── errors ── */
app.use(notFound);
app.use(errorHandler);

module.exports = app;
