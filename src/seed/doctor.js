/**
 * `npm run doctor` — answers "why is my storefront empty?" without guesswork.
 *
 * Checks the database, the text index, the uploaded image files and the URL
 * configuration, then prints a verdict with the exact fix for anything wrong.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const path = require('path');
const fs = require('fs/promises');
const mongoose = require('mongoose');

const connectDB = require('../config/db');
const {
  Admin, Banner, Category, Contact, Coupon, HomeSection, Media,
  Newsletter, Product, Review, SearchHistory, Setting, SubCategory,
} = require('../models');

const UPLOAD_ROOT = path.join(__dirname, '..', '..', process.env.UPLOAD_DIR || 'uploads');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const problems = [];
const ok = (m) => console.log(`  ${GREEN}✓${RESET} ${m}`);
const bad = (m, fix) => { console.log(`  ${RED}✗${RESET} ${m}`); problems.push({ m, fix }); };
const warn = (m) => console.log(`  ${YELLOW}!${RESET} ${m}`);

(async () => {
  await connectDB();
  console.log('');

  /* ── 1. content the storefront needs to render ── */
  console.log('Content');
  const counts = {};
  await Promise.all(
    Object.entries({
      Admin, Category, SubCategory, Product, HomeSection, Banner, Coupon,
      Review, Media, Newsletter, Contact, SearchHistory,
    }).map(async ([name, Model]) => { counts[name] = await Model.countDocuments(); }),
  );
  const settings = await Setting.findOne({ singleton: 'global' });

  const table = Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join('  ');
  console.log(`  ${DIM}${table}${RESET}`);

  if (!counts.Admin) bad('No admin account — you cannot sign in to the panel.', 'npm run seed');
  else ok(`${counts.Admin} admin account(s)`);

  if (!counts.HomeSection) {
    bad('No HomeSection documents — the homepage is built from these, so it renders empty.', 'npm run seed');
  } else ok(`${counts.HomeSection} homepage sections`);

  if (!counts.Product) bad('No products.', 'npm run seed');
  else ok(`${counts.Product} products`);

  if (!counts.Banner) bad('No banners — the hero slider will be missing.', 'npm run seed');
  else ok(`${counts.Banner} banners`);

  if (!counts.Category) bad('No categories.', 'npm run seed');
  else ok(`${counts.Category} categories, ${counts.SubCategory} sub categories`);

  if (!settings) bad('No Settings document — announcement bar, policies and testimonials will be blank.', 'npm run seed');
  else ok('Settings document present');

  /* ── 2. the text index that broke seeding ── */
  console.log('\nIndexes');
  try {
    const indexes = await Product.collection.indexes();
    const text = indexes.find((i) => i.name === 'product_search');
    if (!text) {
      warn('product_search text index missing — search will not work until it is built.');
    } else if (text.language_override !== 'searchLanguage') {
      bad(
        'product_search still uses the default language override, so products with ' +
        'language "Hindi"/"Odia"/"NA" cannot be inserted (MongoServerError 17262).',
        "npm run seed   (drops and rebuilds indexes)   — or in mongosh: db.products.dropIndex('product_search')",
      );
    } else {
      ok('product_search text index has language_override: searchLanguage');
    }
  } catch (err) {
    warn(`Could not read indexes: ${err.message}`);
  }

  /* ── 3. image files on disk ── */
  console.log('\nImages');
  for (const folder of ['products', 'banners']) {
    const dir = path.join(UPLOAD_ROOT, folder);
    const files = (await fs.readdir(dir).catch(() => []))
      .filter((f) => f.endsWith('.webp') || f.endsWith('.svg') || f.endsWith('.png') || f.endsWith('.jpg'));
    if (!files.length) bad(`uploads/${folder}/ has no image files.`, 'npm run seed');
    else ok(`uploads/${folder}/ — ${files.length} files`);
  }

  // Do the stored URLs actually point at this server?
  const sample = await Product.findOne({ 'images.0': { $exists: true } }).select('images title').lean();
  if (sample) {
    const url = sample.images[0].url || '';
    if (!/^https?:\/\//.test(url)) {
      bad(
        `Stored image URLs are not absolute ("${url}"). The storefront runs on another origin, so these 404.`,
        'Set an absolute BACKEND_URL in .env (e.g. http://localhost:5000) then re-run: npm run seed',
      );
    } else {
      // The most common cause of "images don't show": the API moved to a new
      // port, but the URLs written at seed time still point at the old one.
      const expected = (process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, '');
      let storedOrigin = '';
      try { storedOrigin = new URL(url).origin; } catch { /* ignore */ }

      if (storedOrigin && storedOrigin !== expected) {
        bad(
          `Stored image URLs point at ${storedOrigin} but this server is ${expected}. Every product image will 404.`,
          `Set BACKEND_URL=${expected} in .env, then re-run: npm run seed   ` +
          '(the frontends also rewrite the origin at render time, so restarting them may be enough)',
        );
      } else {
        ok(`Image URLs are absolute and match this server — e.g. ${url}`);
      }
    }
  }

  /* ── 4. URL / CORS configuration ── */
  console.log('\nConfiguration');
  const front = process.env.FRONTEND_URL;
  const admin = process.env.ADMIN_URL;
  const backend = process.env.BACKEND_URL;

  if (!backend) warn('BACKEND_URL is not set — falling back to http://localhost:' + (process.env.PORT || 5000));
  else ok(`BACKEND_URL = ${backend}`);

  if (!front) bad('FRONTEND_URL is not set — CORS will reject the storefront.', 'Add FRONTEND_URL=http://localhost:5173 to .env');
  else ok(`FRONTEND_URL = ${front}  ${DIM}(storefront must run on exactly this origin)${RESET}`);

  if (!admin) warn('ADMIN_URL is not set — the admin panel may be blocked by CORS.');
  else ok(`ADMIN_URL = ${admin}`);

  if (!process.env.JWT_SECRET) bad('JWT_SECRET is not set — admin login will fail.', 'Add a long random JWT_SECRET to .env');
  else if (process.env.JWT_SECRET.length < 24) warn('JWT_SECRET is short — use 32+ random characters in production.');
  else ok('JWT_SECRET set');

  const srcKey = process.env.SHIPROCKET_CHECKOUT_API_KEY || process.env.SHIPROCKET_API_KEY;
  const srcSecret = process.env.SHIPROCKET_CHECKOUT_API_SECRET || process.env.SHIPROCKET_CHECKOUT_SECRET || process.env.SHIPROCKET_API_SECRET;
  const srcPrefix = process.env.SHIPROCKET_CHECKOUT_ROUTE_PREFIX || '/shiprocket-checkout';
  if (!srcKey || !srcSecret) {
    warn(`Shiprocket Checkout catalogue endpoints are NOT mounted (${srcPrefix}/*) — set SHIPROCKET_CHECKOUT_API_KEY and _SECRET to enable them.`);
  } else {
    ok(`Shiprocket Checkout mounted at ${srcPrefix}/*  ${DIM}(test: curl -H "x-api-key: <key>" ${process.env.BACKEND_URL || 'http://localhost:5000'}${srcPrefix}/ping?debug=1)${RESET}`);
    if (String(process.env.SHIPROCKET_CHECKOUT_ACCEPT_ORDERS).toLowerCase() === 'true') {
      warn('SHIPROCKET_CHECKOUT_ACCEPT_ORDERS=true — the widget can create orders. Verify the payload shape against the integration doc.');
    }
  }

  if (!process.env.SHIPROCKET_EMAIL || !process.env.SHIPROCKET_PASSWORD) {
    warn('Shiprocket not configured — checkout still works, but shipments must be pushed manually from the panel.');
  } else ok('Shiprocket credentials present');

  /* ── verdict ── */
  console.log('');
  if (!problems.length) {
    console.log(`${GREEN}Everything checks out.${RESET} If the storefront still looks empty, open its`);
    console.log('browser console and Network tab — the failure is on the frontend side.');
  } else {
    console.log(`${RED}${problems.length} problem(s) found:${RESET}`);
    problems.forEach((p, i) => {
      console.log(`\n  ${i + 1}. ${p.m}`);
      console.log(`     ${GREEN}fix:${RESET} ${p.fix}`);
    });
  }
  console.log('');

  await mongoose.connection.close();
  process.exit(problems.length ? 1 : 0);
})().catch(async (err) => {
  console.error(`\n${RED}doctor failed:${RESET}`, err.message);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
