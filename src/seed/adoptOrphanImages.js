#!/usr/bin/env node
/**
 * ────────────────────────────────────────────────────────────────────────────
 *  Rescue orphaned images into the Media library
 * ────────────────────────────────────────────────────────────────────────────
 *
 * THE SITUATION
 * -------------
 * `npm run seed` deleted the product documents but NOT the files on disk. So
 * uploads/products still holds every picture the client uploaded — roughly
 * 32MB of them — with nothing pointing at them any more.
 *
 * Filenames like "WhatsApp-Image-2026-08-12-at-4-14-39-PM" carry no clue about
 * which book they belong to, so automatic re-linking would guess wrong far more
 * often than right. Instead this registers each one in the Media library, where
 * the admin can SEE them as a grid and attach the right one to each product.
 *
 * WHAT IT DOES
 *   • scans uploads/products for image sets (-full / -card / -thumb)
 *   • skips any file still referenced by a product — those are fine
 *   • creates one Media row per orphaned image, tagged `rescued`
 *   • reads image dimensions so the grid lays out properly
 *
 * It creates NOTHING on disk and deletes NOTHING. Run it twice, get the same
 * result — existing Media rows are matched by url and left alone.
 *
 *   npm run adopt:images -- --dry     report only
 *   npm run adopt:images              register them
 *   npm run adopt:images -- --folder banners
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const connectDB = require('../config/db');
const Media = require('../models/Media');
const Product = require('../models/Product');

const DRY = process.argv.includes('--dry');
const fIdx = process.argv.indexOf('--folder');
const FOLDER = fIdx !== -1 ? process.argv[fIdx + 1] : 'products';

const ROOT = path.join(__dirname, '..', '..', process.env.UPLOAD_DIR || 'uploads');
const DIR = path.join(ROOT, FOLDER);

const backendOrigin = () =>
  (process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, '');
const urlFor = (file) => `${backendOrigin()}/${path.basename(ROOT)}/${FOLDER}/${file}`;

/**
 * The pipeline writes three files per image: name.webp, name-card.webp,
 * name-thumb.webp. Group them so the library shows one entry, not three.
 */
function groupVariants(files) {
  const groups = new Map();
  for (const f of files) {
    if (!/\.(webp|jpe?g|png|avif|gif)$/i.test(f)) continue;
    const ext = path.extname(f);
    const base = path.basename(f, ext).replace(/-(card|thumb|full)$/, '');
    if (!groups.has(base)) groups.set(base, {});
    const variant = /-card$/.test(path.basename(f, ext)) ? 'card'
      : /-thumb$/.test(path.basename(f, ext)) ? 'thumb' : 'full';
    groups.get(base)[variant] = f;
  }
  return groups;
}

/** A readable label from an upload filename: strip the timestamp-random prefix. */
function prettyName(base) {
  return base
    .replace(/^\d{10,}-\d+-/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || base;
}

(async () => {
  if (!fs.existsSync(DIR)) {
    console.error(`\n  ${DIR} does not exist.\n`);
    process.exit(1);
  }

  await connectDB();

  const files = fs.readdirSync(DIR);
  const groups = groupVariants(files);
  console.log(`\n  ${files.length} files → ${groups.size} image sets in uploads/${FOLDER}`);

  /* Which files are still referenced by a live product? Those are not orphans. */
  const products = await Product.find({}).select('images').lean();
  const inUse = new Set();
  products.forEach((p) => (p.images || []).forEach((img) => {
    [img.url, img.cardUrl, img.thumbUrl].forEach((u) => {
      if (u) inUse.add(path.basename(u).replace(/-(card|thumb)\.webp$/, '.webp'));
    });
  }));
  console.log(`  ${inUse.size} file(s) still referenced by a product`);

  const existing = new Set((await Media.find({}).select('url').lean()).map((m) => m.url));

  let sharp = null;
  try { sharp = require('sharp'); } catch { /* dimensions become 0 */ }

  const toCreate = [];
  let skippedInUse = 0;
  let skippedKnown = 0;

  for (const [base, v] of groups) {
    const main = v.full || v.card || v.thumb;
    if (!main) continue;
    if (inUse.has(main)) { skippedInUse += 1; continue; }

    const url = urlFor(main);
    if (existing.has(url)) { skippedKnown += 1; continue; }

    let width = 0; let height = 0; let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(path.join(DIR, main)).size;
      if (sharp) {
        const meta = await sharp(path.join(DIR, main)).metadata();
        width = meta.width || 0; height = meta.height || 0;
      }
    } catch { /* keep zeros */ }

    toCreate.push({
      url,
      cardUrl: v.card ? urlFor(v.card) : url,
      thumbUrl: v.thumb ? urlFor(v.thumb) : url,
      filename: main,
      originalName: prettyName(base),
      mimeType: 'image/webp',
      sizeBytes,
      width,
      height,
      folder: ['products', 'banners', 'categories', 'ebooks', 'misc'].includes(FOLDER) ? FOLDER : 'misc',
      alt: prettyName(base),
      // `rescued` lets the admin filter to exactly these, and lets you undo:
      //   db.media.deleteMany({ tags: 'rescued' })
      tags: ['rescued'],
    });
  }

  console.log(`  ${skippedInUse} skipped (in use)   ${skippedKnown} skipped (already in library)`);
  console.log(`  ${toCreate.length} orphaned image(s) to register\n`);

  toCreate.slice(0, 10).forEach((m) => console.log(`    ${m.originalName.slice(0, 60)}`));
  if (toCreate.length > 10) console.log(`    … and ${toCreate.length - 10} more`);

  if (DRY) {
    console.log('\n  --dry: nothing written.\n');
  } else if (toCreate.length) {
    await Media.insertMany(toCreate, { ordered: false });
    console.log(`\n  Registered ${toCreate.length} image(s) in the media library.`);
    console.log('  Admin panel → Media. Filter by the "rescued" tag.\n');
  } else {
    console.log('\n  Nothing to do.\n');
  }

  await mongoose.connection.close();
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
