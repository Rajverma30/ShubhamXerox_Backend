/**
 * ────────────────────────────────────────────────────────────────────────────
 *  Legacy URL resolution — keeps the OLD site's product links working
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Old links live in Google's index, in WhatsApp forwards and in customers'
 * bookmarks. When the domain moves to this store they must land on the right
 * product, not a 404, or the SEO built up on the old site is thrown away.
 *
 * This works because `importLegacyCsv.js` stores every migrated product with
 * `sku = "LEG-<old id>"`. That is the bridge between the two systems.
 *
 * Resolution order, most reliable first:
 *   1. numeric id from the URL  → sku "LEG-<id>"  (or "LEG-n<id>", since the
 *      export used both -271 and 271 as distinct ids)
 *   2. the URL's last path segment matched against the new slug
 *   3. text search on the title, accepted only when the match is unambiguous
 *
 * It is deliberately conservative: an uncertain match returns 404 rather than
 * sending a customer to the wrong book.
 */
const Product = require('../models/Product');
const { ok } = require('../utils/response');
const ApiError = require('../utils/ApiError');
const { toSlug } = require('../utils/slug');
const logger = require('../utils/logger');

const FRONTEND = () => (process.env.FRONTEND_URL || '').replace(/\/$/, '');

/**
 * Pull the useful parts out of any old-style URL.
 * Handles /product/271, /product.php?id=271, /p/271-some-title.html,
 * /all-products/black-book-unit-6, and most things in between.
 */
function extractCandidates(rawUrl = '') {
  let pathname = String(rawUrl);
  let search = '';

  try {
    // Accepts both a full URL and a bare path.
    const u = new URL(pathname, 'http://x.invalid');
    pathname = decodeURIComponent(u.pathname);
    search = u.search;
  } catch {
    pathname = decodeURIComponent(pathname.split('?')[0] || '');
    search = rawUrl.includes('?') ? `?${rawUrl.split('?')[1]}` : '';
  }

  /* Confidence matters here. A number that is a whole path segment, or a
     query parameter, or a leading "271-" prefix, really is an id. A number
     buried inside a slug is NOT — "black-book-unit-6-economy" would otherwise
     resolve to product 6 and send the customer to the wrong book. Those are
     kept separately and only tried after slug matching has failed. */
  const ids = [];
  const weakIds = [];

  // ?id=271 / ?product_id=271 / ?pid=271 — unambiguous.
  const q = /[?&](?:id|pid|product_id|productid|item|p)=(-?\d+)/i.exec(search);
  if (q) ids.push(q[1]);

  const segments = pathname.split('/').filter(Boolean);
  for (const seg of segments) {
    const bare = seg.replace(/\.(html?|php|aspx?)$/i, '');
    if (/^-?\d{1,6}$/.test(bare)) { ids.push(bare); continue; }      // /product/271 or /product/-100
    const lead = /^(-?\d{1,6})-/.exec(bare);
    if (lead) { ids.push(lead[1]); continue; }                      // /271-black-book.html
    const trail = /-(\d{1,6})$/.exec(bare);
    if (trail && !/-(?:19|20)\d{2}-\d{1,2}$/.test(bare)) { weakIds.push(trail[1]); }                              // /some-title-270 (skip year ranges like 2026-27)
  }

  const last = segments[segments.length - 1] || '';
  const slugGuess = toSlug(last.replace(/\.(html?|php|aspx?)$/i, ''));

  return { pathname, ids: [...new Set(ids)], weakIds: [...new Set(weakIds)], slugGuess, segments };
}

/**
 * @returns {Promise<{product, how}|null>}
 */
async function resolveLegacy(rawUrl) {
  const { ids, weakIds, slugGuess } = extractCandidates(rawUrl);

  const bySku = async (list) => {
    if (!list.length) return null;
    for (const id of list) {
      const isNeg = String(id).startsWith('-');
      const cleanId = String(id).replace(/^-/, '');
      const primarySku = isNeg ? `LEG-n${cleanId}` : `LEG-${cleanId}`;
      const secondarySku = isNeg ? `LEG-${cleanId}` : `LEG-n${cleanId}`;

      let hit = await Product.findOne({ sku: primarySku }).select('slug title sku').lean();
      if (hit) return hit;
      hit = await Product.findOne({ sku: secondarySku }).select('slug title sku').lean();
      if (hit) return hit;
    }
    return null;
  };

  /* 1. exact slug carried over from the old title — the safest signal, so it
        runs before id matching. */
  if (slugGuess && slugGuess.length > 2) {
    const hit = await Product.findOne({ $or: [{ slug: slugGuess }, { oldSlugs: slugGuess }] }).select('slug title').lean();
    if (hit) return { product: hit, how: 'exact slug' };
  }

  /* 2. high-confidence legacy id → sku. The export contained both -271 and
        271 as distinct products, imported as LEG-n271 and LEG-271. */
  const strong = await bySku(ids);
  if (strong) return { product: strong, how: `sku ${strong.sku}` };

  /* 3. our slugs gain -2, -3 on collision, so the old slug is often a prefix */
  if (slugGuess && slugGuess.length > 2) {
    const esc = slugGuess.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = await Product.find({ slug: new RegExp(`^${esc}(-\\d+)?$`) })
      .select('slug title').limit(2).lean();
    if (prefix.length === 1) return { product: prefix[0], how: 'slug prefix' };
  }

  /* 4. trailing "-270" style ids — plausible, but "class-10" looks identical,
        so this only runs once slug matching has come up empty. */
  const weak = await bySku(weakIds);
  if (weak) return { product: weak, how: `sku ${weak.sku} (trailing id)` };

  /* 5. last resort: text search, accepted only when there is a clear winner */
  if (slugGuess && slugGuess.length > 6) {
    const words = slugGuess.replace(/-/g, ' ');
    const found = await Product.find(
      { $text: { $search: words }, isActive: true },
      { score: { $meta: 'textScore' } },
    ).select('slug title').sort({ score: { $meta: 'textScore' } }).limit(2).lean();

    if (found.length === 1 && found[0].score > 3.0) return { product: found[0], how: 'text search' };
    if (found.length === 2 && found[0].score > 3.0 && found[0].score > found[1].score * 1.6) {
      return { product: found[0], how: 'text search' };
    }
  }

  return null;
}

/**
 * GET /api/legacy/resolve?path=/old/product/271
 *
 * For the storefront: its 404 page calls this before rendering "not found",
 * so old links work even when the site is served by Firebase Hosting / a CDN
 * that cannot query the database itself.
 */
exports.resolve = async (req, res) => {
  const target = req.query.path || req.query.url;
  if (!target) throw ApiError.badRequest('Pass ?path=/the/old/url');

  const match = await resolveLegacy(target);
  if (!match) return ok(res, { found: false });

  return ok(res, {
    found: true,
    slug: match.product.slug,
    title: match.product.title,
    url: `/product/${match.product.slug}`,
    matchedBy: match.how,
  });
};

/**
 * Express middleware: 301 the request itself.
 *
 * Only useful when the old domain points at THIS server (nginx / VPS). If the
 * old domain points at Firebase Hosting instead, use the /api/legacy/resolve
 * endpoint from the storefront's 404 page.
 *
 * Enable with LEGACY_REDIRECT=true. Off by default so it can never surprise
 * you on a fresh deploy.
 */
exports.redirectMiddleware = async (req, res, next) => {
  if (String(process.env.LEGACY_REDIRECT).toLowerCase() !== 'true') return next();
  if (req.method !== 'GET') return next();

  // Never touch the API, uploads, img alias, health or SEO files.
  if (/^\/(api|uploads|img|health|sitemap\.xml|robots\.txt|shiprocket-checkout)/.test(req.path)) return next();

  try {
    const match = await resolveLegacy(req.originalUrl);
    if (!match) return next();

    const dest = `${FRONTEND()}/product/${match.product.slug}`;
    logger.info(`Legacy 301  ${req.originalUrl}  →  ${dest}  (${match.how})`);
    return res.redirect(301, dest);
  } catch (err) {
    logger.warn(`Legacy redirect failed for ${req.originalUrl}: ${err.message}`);
    return next();
  }
};

exports.resolveLegacy = resolveLegacy;
exports.extractCandidates = extractCandidates;
