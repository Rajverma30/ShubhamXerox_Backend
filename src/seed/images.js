/**
 * Demo imagery for the seeder.
 *
 * Downloads real photographs once into a local cache, then composites branded
 * artwork over them with sharp — so a seeded store looks like a real shop
 * rather than a wall of gradients.
 *
 *   photo (Lorem Picsum / Unsplash)  +  typographic overlay  =  product cover
 *
 * Everything degrades safely:
 *   • no network        → falls back to the pure-SVG gradient covers
 *   • SEED_REAL_IMAGES=false → skips downloading entirely
 *   • cached pool       → re-seeding is instant, no re-download
 *
 * NOTE FOR PRODUCTION: these are stock photos for demo purposes. Replace them
 * with the client's own product photography via the admin panel before launch.
 */
const path = require('path');
const fs = require('fs/promises');
const sharp = require('sharp');
const logger = require('../utils/logger');

const BASE = process.env.SEED_IMAGE_BASE || 'https://picsum.photos';
const POOL_SIZE = Number(process.env.SEED_PHOTO_POOL) || 42;
const ENABLED = String(process.env.SEED_REAL_IMAGES ?? 'true').toLowerCase() !== 'false';

const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Wrap text to a line budget for the cover typography. */
function wrap(text, perLine = 18, maxLines = 4) {
  const words = String(text).split(' ');
  const lines = [];
  let line = '';
  words.forEach((w) => {
    if (`${line} ${w}`.trim().length > perLine) {
      if (line) lines.push(line.trim());
      line = w;
    } else {
      line = `${line} ${w}`.trim();
    }
  });
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

/* ─────────────────────────── photo pool ─────────────────────────── */

let pool = [];       // Buffers of downloaded portrait photos
let widePool = [];   // Buffers for banners

async function fetchPhoto(seed, w, h) {
  const url = `${BASE}/seed/${seed}/${w}/${h}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** Run `jobs` with a small concurrency cap so we don't hammer the service. */
async function pooled(items, worker, concurrency = 5) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const idx = i;
        i += 1;
        // eslint-disable-next-line no-await-in-loop
        out[idx] = await worker(items[idx], idx);
      }
    }),
  );
  return out;
}

/**
 * Fill the photo pool, using a disk cache so a second `npm run seed` is instant.
 * @returns {boolean} whether real photos are available
 */
async function preparePool(cacheDir) {
  if (!ENABLED) {
    logger.info('SEED_REAL_IMAGES=false — using generated cover art');
    return false;
  }
  if (typeof fetch !== 'function') {
    logger.warn('global fetch unavailable (Node 18+ required) — using generated cover art');
    return false;
  }

  await fs.mkdir(cacheDir, { recursive: true });

  const portraitSeeds = Array.from({ length: POOL_SIZE }, (_, i) => `sx-p-${i}`);
  const wideSeeds = Array.from({ length: 8 }, (_, i) => `sx-w-${i}`);

  let downloaded = 0;
  let failed = 0;

  const load = (w, h) => async (seed) => {
    const cached = path.join(cacheDir, `${seed}-${w}x${h}.jpg`);
    try {
      return await fs.readFile(cached);
    } catch {
      /* not cached yet */
    }
    try {
      const buf = await fetchPhoto(seed, w, h);
      await fs.writeFile(cached, buf);
      downloaded += 1;
      return buf;
    } catch (err) {
      failed += 1;
      if (failed === 1) logger.warn(`Photo download failed (${err.message}) — will fall back where needed`);
      return null;
    }
  };

  logger.info(`Fetching demo photographs from ${BASE} (cached in ${path.relative(process.cwd(), cacheDir)})…`);
  pool = (await pooled(portraitSeeds, load(900, 1200))).filter(Boolean);
  widePool = (await pooled(wideSeeds, load(1920, 760))).filter(Boolean);

  const cachedCount = pool.length + widePool.length - downloaded;
  logger.info(
    `Photos ready: ${pool.length} portrait + ${widePool.length} wide ` +
    `(${downloaded} downloaded, ${cachedCount} from cache${failed ? `, ${failed} failed` : ''})`,
  );

  if (!pool.length) {
    logger.warn('No photographs available — falling back to generated cover art.');
    return false;
  }
  return true;
}

const hasPhotos = () => pool.length > 0;
const takePhoto = (i) => pool[Math.abs(i) % pool.length];
const takeWide = (i) => (widePool.length ? widePool[Math.abs(i) % widePool.length] : null);

/* ─────────────────────── overlay artwork ─────────────────────── */

/**
 * Book-cover treatment: darkened photo, publisher band, title block.
 * Reads like a designed jacket rather than a stock photo with words on it.
 */
function bookOverlaySvg({ title, subtitle, badge, palette, variant }) {
  const [dark, accent] = palette;
  const lines = wrap(title, variant % 2 === 0 ? 17 : 20, 4);
  const titleSize = lines.length > 3 ? 62 : 72;
  const blockTop = 1200 - 120 - lines.length * (titleSize + 12) - (subtitle ? 60 : 0);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${dark}" stop-opacity="0.86"/>
      <stop offset="42%" stop-color="${dark}" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="${dark}" stop-opacity="0.96"/>
    </linearGradient>
    <linearGradient id="spine" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#000" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="900" height="1200" fill="url(#scrim)"/>
  <rect width="46" height="1200" fill="url(#spine)"/>

  <text x="74" y="112" font-family="Georgia, serif" font-size="30" fill="#ffffff" fill-opacity="0.92" letter-spacing="7">SUBHAM XEROX</text>
  <rect x="74" y="132" width="86" height="3" fill="${accent}"/>

  ${badge ? `<rect x="74" y="168" rx="17" width="${Math.min(470, badge.length * 18 + 42)}" height="50" fill="${accent}"/>
  <text x="95" y="202" font-family="Helvetica, Arial, sans-serif" font-size="24" font-weight="700" fill="#ffffff" letter-spacing="1.5">${esc(badge.toUpperCase())}</text>` : ''}

  ${lines.map((l, i) => `<text x="74" y="${blockTop + i * (titleSize + 12)}" font-family="Georgia, serif" font-size="${titleSize}" font-weight="700" fill="#ffffff">${esc(l)}</text>`).join('\n  ')}

  ${subtitle ? `<text x="74" y="${blockTop + lines.length * (titleSize + 12) + 22}" font-family="Helvetica, Arial, sans-serif" font-size="32" fill="#ffffff" fill-opacity="0.82">${esc(subtitle)}</text>` : ''}

  <rect x="74" y="1096" width="${Math.min(300, 120 + title.length * 2)}" height="2" fill="#ffffff" fill-opacity="0.35"/>
  <text x="74" y="1140" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="#ffffff" fill-opacity="0.62">Edition ${2026 - (variant % 3)}</text>
</svg>`;
}

/** Stationery treatment: keep the photo bright, add a small product label. */
function stationeryOverlaySvg({ title, subtitle, badge, palette }) {
  const [dark, accent] = palette;
  const lines = wrap(title, 22, 3);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200">
  <defs>
    <linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${dark}" stop-opacity="0.05"/>
      <stop offset="58%" stop-color="${dark}" stop-opacity="0.32"/>
      <stop offset="100%" stop-color="${dark}" stop-opacity="0.92"/>
    </linearGradient>
  </defs>
  <rect width="900" height="1200" fill="url(#s)"/>

  ${badge ? `<rect x="64" y="64" rx="16" width="${Math.min(420, badge.length * 17 + 40)}" height="46" fill="#ffffff" fill-opacity="0.94"/>
  <text x="84" y="95" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="700" fill="${dark}" letter-spacing="1.2">${esc(badge.toUpperCase())}</text>` : ''}

  ${lines.map((l, i) => `<text x="64" y="${980 + i * 58}" font-family="Helvetica, Arial, sans-serif" font-size="50" font-weight="700" fill="#ffffff">${esc(l)}</text>`).join('\n  ')}
  ${subtitle ? `<text x="64" y="${980 + lines.length * 58 + 18}" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="${accent}" font-weight="600">${esc(subtitle)}</text>` : ''}
</svg>`;
}

/** Banner treatment: photo with a left-weighted scrim for the copy. */
function bannerOverlaySvg({ title, subtitle, eyebrow, palette }) {
  const [dark] = palette;
  const lines = wrap(title, 26, 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="760" viewBox="0 0 1920 760">
  <defs>
    <linearGradient id="b" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${dark}" stop-opacity="0.94"/>
      <stop offset="55%" stop-color="${dark}" stop-opacity="0.62"/>
      <stop offset="100%" stop-color="${dark}" stop-opacity="0.18"/>
    </linearGradient>
  </defs>
  <rect width="1920" height="760" fill="url(#b)"/>
  ${eyebrow ? `<text x="120" y="264" font-family="Helvetica, Arial, sans-serif" font-size="28" letter-spacing="8" fill="#ffffff" fill-opacity="0.8">${esc(eyebrow.toUpperCase())}</text>` : ''}
  ${lines.map((l, i) => `<text x="120" y="${360 + i * 84}" font-family="Georgia, serif" font-size="76" font-weight="700" fill="#ffffff">${esc(l)}</text>`).join('\n  ')}
  ${subtitle ? `<text x="120" y="${392 + lines.length * 84}" font-family="Helvetica, Arial, sans-serif" font-size="32" fill="#ffffff" fill-opacity="0.86">${esc(subtitle)}</text>` : ''}
</svg>`;
}

/* ─────────────────────── composition ─────────────────────── */

/**
 * Real photo + overlay → a single cover image buffer.
 * Returns null when no photo is available, so the caller can fall back.
 */
async function composeCover({ photoIndex, title, subtitle, badge, palette, variant, kind = 'book' }) {
  if (!hasPhotos()) return null;
  const photo = takePhoto(photoIndex);
  if (!photo) return null;

  const overlay = kind === 'stationery'
    ? stationeryOverlaySvg({ title, subtitle, badge, palette })
    : bookOverlaySvg({ title, subtitle, badge, palette, variant });

  try {
    return await sharp(photo)
      .resize(900, 1200, { fit: 'cover', position: variant % 2 ? 'attention' : 'centre' })
      // A touch of desaturation keeps the typography legible over busy photos.
      .modulate({ saturation: kind === 'stationery' ? 1.05 : 0.82 })
      .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }])
      .toBuffer();
  } catch (err) {
    logger.debug(`composeCover failed: ${err.message}`);
    return null;
  }
}

async function composeBanner({ photoIndex, title, subtitle, eyebrow, palette }) {
  const photo = takeWide(photoIndex);
  if (!photo) return null;
  try {
    return await sharp(photo)
      .resize(1920, 760, { fit: 'cover' })
      .modulate({ saturation: 0.9 })
      .composite([{ input: Buffer.from(bannerOverlaySvg({ title, subtitle, eyebrow, palette })), top: 0, left: 0 }])
      .toBuffer();
  } catch (err) {
    logger.debug(`composeBanner failed: ${err.message}`);
    return null;
  }
}

module.exports = { preparePool, hasPhotos, composeCover, composeBanner, wrap, esc, ENABLED };
