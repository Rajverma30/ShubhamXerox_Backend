#!/usr/bin/env node
/**
 * ────────────────────────────────────────────────────────────────────────────
 *  Legacy CSV → MongoDB importer
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Imports the old site's product export (id,name,category,price,img,desc,
 * original_price,exam,free_note_id) into the Category + Product collections.
 *
 * Place this file at:  src/seed/importLegacyCsv.js
 *
 * The 431-product export SHIPS WITH THIS BACKEND as
 * `src/seed/legacyProducts.json`, so nothing needs copying to the server.
 * Every command below works with no --file at all.
 *
 * USAGE
 *   # 1. See what it will do — no DB connection, no writes:
 *   npm run import:csv -- --preview
 *
 *   # 2. Connect and validate, still no writes:
 *   node src/seed/importLegacyCsv.js --file ./products.csv --dry
 *
 *   # 3. Import for real:
 *   node src/seed/importLegacyCsv.js --file ./products.csv
 *
 *   # 4. With images (the all-products_files folder from the old site):
 *   node src/seed/importLegacyCsv.js --file ./products.csv --images ./all-products_files
 *
 * FLAGS
 *   --file <path>     CSV to import                        (required)
 *   --images <dir>    Folder holding the files `img` points at
 *   --preview         Parse + map + print. No DB, no writes.
 *   --dry             Connect and report, but write nothing.
 *   --update          Overwrite products that were already imported.
 *                     Without this, existing rows are skipped.
 *   --limit <n>       Only process the first n rows (for a test run).
 *   --stock <n>       Default stock per product           (default 25)
 *   --wipe            DELETE every existing product, category, subcategory
 *                     and review first. Use when replacing a demo catalogue
 *                     with the client's real one. Irreversible.
 *   --slug-max <n>    Old-site slug truncation length      (default 120)
 *
 * IDEMPOTENCY
 *   Each product is stored with sku = "LEG-<csv id>". Re-running skips rows
 *   that already exist, so an interrupted import can simply be re-run.
 *   `--update` refreshes them instead.
 *
 * MAPPING DECISIONS (change these if your client disagrees)
 *   csv.category      → Category document (39 of them: publishers / series)
 *   csv.exam          → tags[]  ("MPPSC", "UPSC", …)
 *   csv.original_price→ product.price      (MRP, the struck-through number)
 *   csv.price         → product.salePrice  (what the customer actually pays)
 *                       If original_price is missing or <= price, price is
 *                       used as the MRP and salePrice is left null.
 *   csv.name          → title, and the EXACT old-site slug, so
 *                       /products/<slug> is byte-identical to the old URL
 *   category "Stationery" → type: 'stationery', everything else → 'book'
 *   Devanagari in title   → language: 'Hindi', else 'English'
 *   csv.free_note_id  → not mapped (old system's note IDs). Listed in the
 *                       final report so you can wire them up manually.
 */
// Optional so `--preview` runs from any folder, before npm install.
try { require('dotenv').config(); } catch { /* preview mode needs no env */ }

const fs = require('fs');
const path = require('path');

/* ── CLI args ─────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

// The 431-product export ships with the backend as JSON, so nothing has to be
// copied to the server. Pass --file only to import a different/newer export.
const BUNDLED = path.join(__dirname, 'legacyProducts.json');
const FILE = opt('file') || (fs.existsSync(BUNDLED) ? BUNDLED : null);
const IMAGES_DIR = opt('images');
const PREVIEW = flag('preview');
const DRY = flag('dry');
const UPDATE = flag('update');
const WIPE = flag('wipe');
const LIMIT = Number(opt('limit')) || Infinity;
const DEFAULT_STOCK = Number(opt('stock')) || 25;

if (!FILE) {
  console.error(
    'No data file found.\n' +
    `Expected the bundled export at ${BUNDLED}, or pass --file <path-to-csv|json>.\n` +
    'Run with --preview first to check the mapping.',
  );
  process.exit(1);
}

/* ── tiny colour helpers (no dependency) ──────────────────────────────── */
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/* ── RFC-4180 CSV parser ──────────────────────────────────────────────────
   Written inline so the import needs no new npm package. Handles quoted
   fields, embedded commas, embedded newlines and doubled quotes — all of
   which appear in this export (book titles contain commas and quotes). */
function parseCsv(text) {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } // escaped quote
        else inQuotes = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift().map((h) => h.trim());
  return rows
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/* ── mapping helpers ──────────────────────────────────────────────────── */
const DEVANAGARI = /[ऀ-ॿ]/;

/**
 * THE OLD SITE'S SLUG RULE — reverse-engineered from a live URL and verified.
 *
 *   name: "Tathyaban MPPSC Previous Year Questions 2026 | 55 Solved Question
 *          Papers | State PSC, Police SI, Forest, Excise & Other MP
 *          Competitive Exams | Hindi Medium"
 *   url : /products/tathyaban-mppsc-previous-year-questions-2026-55-solved-
 *         question-papers-state-psc-police-si-forest-excise-other-mp-compet
 *
 * Rules: lowercase → every run of non-alphanumerics becomes one hyphen →
 * trim hyphens → HARD TRUNCATE AT 120 CHARACTERS → trim a trailing hyphen.
 * The truncation is a blunt cut mid-word ("compet"), which is what pins the
 * length at exactly 120.
 *
 * Do NOT use the `slugify` package here. With its default charmap "&" becomes
 * "and", producing "excise-and-other" where the live URL has "excise-other".
 * The whole point is byte-identical URLs, so the rule is reimplemented.
 */
const LEGACY_SLUG_MAX = Number(opt('slug-max')) || 120;

function legacySlug(str = '') {
  const s = String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, LEGACY_SLUG_MAX).replace(/-+$/, '');
}

/** Local slugify so --preview works without loading the app's node_modules. */
function basicSlug(str = '') {
  return String(str)
    .toLowerCase()
    .replace(/[‘’“”]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

const num = (v) => {
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/**
 * One CSV row → a plain object shaped like the Product schema.
 * Pure function: no DB, no side effects. This is what --preview prints.
 */
function mapRow(row, { stock = DEFAULT_STOCK } = {}) {
  // This export contains BOTH negative and positive ids (-271 and 271 are two
  // different products — 431 ids, all distinct). Do not strip the sign or 160
  // SKUs collide. Negatives become "n271" so the SKU reads LEG-n271.
  const legacyId = String(row.id || '').trim().replace(/^-/, 'n');
  const title = (row.name || '').replace(/\s+/g, ' ').trim();
  const categoryName = (row.category || 'General').trim() || 'General';

  /* pricing: the export's `price` is what was charged, `original_price` the MRP */
  const charged = num(row.price);
  const mrp = num(row.original_price);
  const hasRealMrp = mrp > 0 && mrp > charged;

  const price = hasRealMrp ? Math.round(mrp) : Math.round(charged);
  const salePrice = hasRealMrp ? Math.round(charged) : null;

  /* exam column is free text: "MPPSC, UPSC/IAS, SSC CGL" → separate tags */
  const tags = (row.exam || '')
    .split(/[,/]/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  const isStationery = /stationery/i.test(categoryName);
  const language = DEVANAGARI.test(title) ? 'Hindi' : 'English';

  /* The slug IS the old site's URL — it must match exactly so existing links,
     Google results and WhatsApp shares keep working after the domain change. */
  const exactSlug = legacySlug(title);
  const slugSeed = exactSlug.length >= 3 ? exactSlug : `product-${legacyId}`;

  return {
    legacyId,
    sku: `LEG-${legacyId}`,
    title,
    slugSeed,
    slugWillFallBack: exactSlug.length < 3,
    type: isStationery ? 'stationery' : 'book',
    price,
    salePrice,
    currency: 'INR',
    stock,
    language,
    description: (row.desc || '').trim(),
    shortDescription: (row.desc || '').trim().slice(0, 320),
    tags: [...new Set([...tags, basicSlug(categoryName)].filter(Boolean))],
    categoryName,
    imgPath: (row.img || '').trim(),
    freeNoteId: (row.free_note_id || '').trim(),
    isActive: true,
    weight: isStationery ? 0.2 : 0.4,
    seo: {
      metaTitle: title.slice(0, 160),
      metaDescription: (row.desc || title).slice(0, 320),
    },
  };
}

/* ── preview mode: parse + map + print, no database ───────────────────── */
function runPreview(mapped) {
  const byCategory = mapped.reduce((acc, m) => {
    acc[m.categoryName] = (acc[m.categoryName] || 0) + 1;
    return acc;
  }, {});

  console.log(C.bold('\n═══ PREVIEW — nothing will be written ═══\n'));
  console.log(`Rows parsed        : ${C.cyan(mapped.length)}`);
  console.log(`Categories to create: ${C.cyan(Object.keys(byCategory).length)}`);
  console.log(`Discounted products : ${C.cyan(mapped.filter((m) => m.salePrice).length)}`);
  console.log(`Hindi titles        : ${C.cyan(mapped.filter((m) => m.language === 'Hindi').length)}`);
  console.log(`Slug falls back to id: ${C.cyan(mapped.filter((m) => m.slugWillFallBack).length)} ${C.dim('(Devanagari-only titles)')}`);
  console.log(`With description    : ${C.cyan(mapped.filter((m) => m.description).length)}`);
  console.log(`With free_note_id   : ${C.cyan(mapped.filter((m) => m.freeNoteId).length)} ${C.dim('(not mapped — see report)')}`);

  const zeroPrice = mapped.filter((m) => !m.price);
  const noTitle = mapped.filter((m) => !m.title);
  const dupSku = Object.entries(
    mapped.reduce((a, m) => { a[m.sku] = (a[m.sku] || 0) + 1; return a; }, {}),
  ).filter(([, n]) => n > 1);

  if (zeroPrice.length) console.log(C.yellow(`\n! ${zeroPrice.length} rows have no price — they will be skipped.`));
  if (noTitle.length) console.log(C.yellow(`! ${noTitle.length} rows have no name — they will be skipped.`));
  if (dupSku.length) console.log(C.yellow(`! ${dupSku.length} duplicate legacy ids: ${dupSku.map(([s]) => s).join(', ')}`));

  console.log(C.bold('\n─── Categories ───'));
  Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .forEach(([name, n]) => console.log(`  ${String(n).padStart(4)}  ${name}`));

  console.log(C.bold('\n─── First 3 mapped products ───'));
  mapped.slice(0, 3).forEach((m) => {
    console.log(C.dim('  ─────────────────────────────────────'));
    console.log(`  sku        : ${m.sku}`);
    console.log(`  title      : ${m.title.slice(0, 70)}${m.title.length > 70 ? '…' : ''}`);
    console.log(`  category   : ${m.categoryName}`);
    console.log(`  price(MRP) : ₹${m.price}   salePrice: ${m.salePrice ? `₹${m.salePrice}` : C.dim('none')}`);
    console.log(`  type       : ${m.type}   language: ${m.language}`);
    console.log(`  tags       : ${m.tags.join(', ') || C.dim('none')}`);
    console.log(`  image      : ${m.imgPath || C.dim('none')}`);
  });

  console.log(C.bold('\nLooks right? Run again without --preview to import.\n'));
}

/* ── full import ──────────────────────────────────────────────────────── */
async function runImport(mapped) {
  /* Required lazily so --preview works from anywhere. */
  const mongoose = require('mongoose');
  const connectDB = require('../config/db');
  const Product = require('../models/Product');
  const Category = require('../models/Category');
  const { uniqueSlug, toSlug } = require('../utils/slug');

  await connectDB();

  /**
   * Reserve the exact legacy slug. Only if it is genuinely taken by a
   * DIFFERENT product do we append -2, -3. Three titles in this export
   * truncate to the same 120 characters, so a handful cannot all keep the
   * pristine URL — the first one processed wins, which matches how the old
   * site would have behaved.
   */
  const exactSlug = async (wanted, ignoreId = null) => {
    let slug = wanted;
    let n = 1;
    /* eslint-disable no-await-in-loop */
    while (true) {
      const q = { slug };
      if (ignoreId) q._id = { $ne: ignoreId };
      if (!(await Product.exists(q))) return slug;
      n += 1;
      slug = `${wanted}-${n}`;
    }
  };

  /* ── 0. wipe ── */
  if (WIPE) {
    if (DRY) {
      console.log(C.yellow('  --wipe: would delete ALL products, categories and subcategories'));
    } else {
      const SubCategory = require('../models/SubCategory');
      const Review = require('../models/Review');
      const before = await Product.countDocuments();
      await Promise.all([
        Product.deleteMany({}),
        Category.deleteMany({}),
        SubCategory.deleteMany({}),
        Review.deleteMany({}),
      ]);
      console.log(C.red(`  WIPED ${before} products + all categories/subcategories/reviews\n`));
    }
  }

  const report = {
    created: 0, updated: 0, skipped: 0, failed: 0,
    categoriesCreated: 0, imagesAttached: 0, imagesMissing: 0,
    errors: [], freeNotes: [],
  };

  /* ── 1. categories ── */
  const categoryNames = [...new Set(mapped.map((m) => m.categoryName))];
  const catByName = new Map();

  for (const name of categoryNames) {
    let cat = await Category.findOne({ name });
    if (!cat) {
      if (DRY) {
        console.log(C.dim(`  would create category: ${name}`));
        catByName.set(name, { _id: new mongoose.Types.ObjectId(), name, slug: toSlug(name) });
        report.categoriesCreated += 1;
        continue;
      }
      cat = await Category.create({
        name,
        slug: await uniqueSlug(Category, name),
        isActive: true,
        showOnHomepage: false,
        description: `Books and notes from ${name}.`,
      });
      report.categoriesCreated += 1;
      console.log(C.green(`  + category  ${name}`));
    }
    catByName.set(name, cat);
  }

  /* ── 2. images (optional) ── */
  let processImage = null;
  if (IMAGES_DIR) {
    if (!fs.existsSync(IMAGES_DIR)) {
      console.error(C.red(`--images "${IMAGES_DIR}" does not exist.`));
      process.exit(1);
    }
    ({ processImage } = require('../services/image.service'));
  }

  const { TMP } = require('../middleware/upload');

  /**
   * Copy the legacy file into uploads/tmp and run it through the normal
   * image pipeline (webp at thumb/card/full), exactly as an admin upload.
   * processImage() deletes its input, hence the copy.
   */
  async function attachImage(m) {
    if (!processImage || !m.imgPath) return null;
    const src = path.join(IMAGES_DIR, path.basename(m.imgPath));
    if (!fs.existsSync(src)) { report.imagesMissing += 1; return null; }

    const tmp = path.join(TMP, `legacy-${m.legacyId}-${Date.now()}${path.extname(src) || '.webp'}`);
    await fs.promises.copyFile(src, tmp);
    try {
      const img = await processImage(tmp, { folder: 'products', alt: m.title.slice(0, 120) });
      report.imagesAttached += 1;
      return { ...img, source: 'upload' };
    } catch (err) {
      await fs.promises.unlink(tmp).catch(() => {});
      report.imagesMissing += 1;
      console.log(C.yellow(`  ! image failed for ${m.sku}: ${err.message}`));
      return null;
    }
  }

  /* ── 3. products ── */
  console.log(C.bold(`\nImporting ${mapped.length} products…\n`));

  for (const [i, m] of mapped.entries()) {
    if (!m.title || !m.price) {
      report.skipped += 1;
      report.errors.push(`${m.sku}: missing ${!m.title ? 'title' : 'price'}`);
      continue;
    }

    try {
      const existing = await Product.findOne({ sku: m.sku });

      if (existing && !UPDATE) { report.skipped += 1; continue; }

      const cat = catByName.get(m.categoryName);
      const image = await attachImage(m);

      const fields = {
        title: m.title,
        sku: m.sku,
        type: m.type,
        price: m.price,
        salePrice: m.salePrice,
        currency: m.currency,
        stock: m.stock,
        language: m.language,
        description: m.description,
        shortDescription: m.shortDescription,
        tags: m.tags,
        category: cat._id,
        categorySlug: cat.slug,
        categoryName: cat.name,
        weight: m.weight,
        isActive: m.isActive,
        seo: m.seo,
      };

      if (DRY) {
        report[existing ? 'updated' : 'created'] += 1;
      } else if (existing) {
        Object.assign(existing, fields);
        // Keep the URL pinned to the old site's slug even on re-import.
        existing.slug = await exactSlug(m.slugSeed, existing._id);
        if (image) existing.images = [image];
        await existing.save();
        report.updated += 1;
      } else {
        const doc = new Product({
          ...fields,
          slug: await exactSlug(m.slugSeed),
          images: image ? [image] : [],
        });
        await doc.save();
        report.created += 1;
      }

      if (m.freeNoteId) report.freeNotes.push(`${m.sku} → free_note_id ${m.freeNoteId}`);

      if ((i + 1) % 25 === 0) {
        process.stdout.write(C.dim(`  … ${i + 1}/${mapped.length}\n`));
      }
    } catch (err) {
      report.failed += 1;
      report.errors.push(`${m.sku}: ${err.message}`);
      console.log(C.red(`  ✗ ${m.sku}: ${err.message}`));
    }
  }

  /* ── 4. keep category.productCount honest ── */
  if (!DRY) {
    for (const cat of catByName.values()) {
      const count = await Product.countDocuments({ category: cat._id, isActive: true });
      await Category.updateOne({ _id: cat._id }, { productCount: count });
    }
  }

  /* ── 5. report ── */
  console.log(C.bold(`\n═══ ${DRY ? 'DRY RUN — nothing written' : 'IMPORT COMPLETE'} ═══\n`));
  console.log(`  categories created : ${C.cyan(report.categoriesCreated)}`);
  console.log(`  products created   : ${C.green(report.created)}`);
  console.log(`  products updated   : ${C.cyan(report.updated)}`);
  console.log(`  skipped            : ${C.yellow(report.skipped)} ${C.dim(UPDATE ? '' : '(already imported — use --update to refresh)')}`);
  console.log(`  failed             : ${report.failed ? C.red(report.failed) : 0}`);
  if (IMAGES_DIR) {
    console.log(`  images attached    : ${C.green(report.imagesAttached)}`);
    console.log(`  images missing     : ${C.yellow(report.imagesMissing)}`);
  }

  if (report.errors.length) {
    const out = path.join(process.cwd(), 'import-errors.log');
    fs.writeFileSync(out, report.errors.join('\n'), 'utf8');
    console.log(C.yellow(`\n  ${report.errors.length} issues written to ${out}`));
  }
  if (report.freeNotes.length) {
    const out = path.join(process.cwd(), 'import-free-notes.log');
    fs.writeFileSync(out, report.freeNotes.join('\n'), 'utf8');
    console.log(C.dim(`  ${report.freeNotes.length} free_note_id links written to ${out} (map these by hand)`));
  }

  console.log(C.dim('\n  Next: npm run doctor\n'));
  await mongoose.connection.close();
}

/* ── entry point ──────────────────────────────────────────────────────── */
(async () => {
  const csvPath = path.resolve(FILE);
  if (!fs.existsSync(csvPath)) {
    console.error(C.red(`CSV not found: ${csvPath}`));
    process.exit(1);
  }

  // .json = the bundled export (already parsed rows). .csv = parse it.
  const raw = fs.readFileSync(csvPath, 'utf8');
  const rows = csvPath.toLowerCase().endsWith('.json') ? JSON.parse(raw) : parseCsv(raw);
  if (!Array.isArray(rows) || !rows.length) {
    console.error(C.red(`${csvPath} contained no rows.`));
    process.exit(1);
  }
  console.log(C.dim(`Source: ${csvPath}  (${rows.length} rows)\n`));
  const mapped = rows.slice(0, LIMIT).map((r) => mapRow(r));

  if (PREVIEW) return runPreview(mapped);
  return runImport(mapped);
})().catch((err) => {
  console.error(C.red(`\nImport aborted: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
