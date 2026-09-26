#!/usr/bin/env node
/**
 * ────────────────────────────────────────────────────────────────────────────
 *  Two-level taxonomy — WITHOUT touching a single product URL
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The CSV import produced 40 flat categories, because that is all the export
 * had: a mix of exam names, coaching institutes, publishers and product types
 * sitting at the same level. Browsing 40 unrelated entries is not a shop.
 *
 * This reshapes them into broad categories with the original 40 as
 * subcategories underneath:
 *
 *     Exam Books        →  MPPSC, UPSC Special Books
 *     Coaching Notes    →  AAKAR IAS PRE, NIRMAN IAS NOTES, Champion Square…
 *     Publications      →  TMH, Lucent, Ghatna Chakra, Darpan…
 *     Test Series       →  MPPSC MAINS TEST SERIES, MPPSC PRE TEST 2026
 *     Xerox & Copies    →  XEROX, Spiral Copies
 *     Stationery        →  Stationery
 *     General           →  General
 *
 * PRODUCT LINKS ARE UNTOUCHED. A product's slug has nothing to do with its
 * category — /products/<slug> stays byte-identical. Only `category`,
 * `subCategory` and their denormalised name/slug fields change.
 *
 *   npm run taxonomy -- --dry     show the plan, write nothing
 *   npm run taxonomy              apply
 *
 * Re-runnable: matches by name, so running twice changes nothing.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Category = require('../models/Category');
const SubCategory = require('../models/SubCategory');
const Product = require('../models/Product');
const { toSlug } = require('../utils/slug');

const DRY = process.argv.includes('--dry');

/**
 * Top-level groups, in the order they should appear on the storefront.
 * `match` runs against the ORIGINAL category name, first hit wins, so order
 * matters — "MPPSC MAINS TEST SERIES" must be caught by Test Series before
 * Exam Books claims it for containing "MPPSC".
 */
const GROUPS = [
  {
    name: 'Test Series',
    description: 'Practice test series and mock papers.',
    color: '#b45309',
    match: (n) => /test series|test\s*\d{4}|pre test|mains test/i.test(n),
  },
  {
    name: 'Xerox & Spiral Copies',
    description: 'Photocopied notes and spiral-bound compilations.',
    color: '#475569',
    match: (n) => /xerox|spiral|copies/i.test(n),
  },
  {
    name: 'Stationery',
    description: 'Pens, notebooks, files, registers and art supplies.',
    color: '#0369a1',
    match: (n) => /stationery|stationary/i.test(n),
  },
  {
    name: 'Coaching Notes',
    description: 'Printed notes from leading coaching institutes.',
    color: '#7c2d12',
    match: (n) => /notes|ias|coaching|champion|saransh|mgics|karma|utkarsh|drishti|unacademy|sir$|parmar|civil jobs/i.test(n),
  },
  {
    name: 'Publications',
    description: 'Titles from established publishers.',
    color: '#166534',
    match: (n) => /publication|prakashan|lucent|tmh|rakesh yadav|omkar|cosmos|devnagari|darpan|ghatna|tathyabaan|punekar|selection tak|kabir/i.test(n),
  },
  {
    name: 'Exam Books',
    description: 'Guides and reference books for competitive exams.',
    color: '#991b1b',
    match: (n) => /mppsc|upsc|ssc|psc|vyapam|police|banking|exam/i.test(n),
  },
  {
    name: 'General',
    description: 'Everything else.',
    color: '#334155',
    match: () => true,                    // catch-all, must stay last
  },
];

const groupFor = (name) => GROUPS.find((g) => g.match(name)) || GROUPS[GROUPS.length - 1];

(async () => {
  await connectDB();

  /* The current flat categories are what become subcategories. Anything this
     script created on a previous run is skipped by name. */
  const topNames = new Set(GROUPS.map((g) => g.name));
  const flat = await Category.find({ name: { $nin: [...topNames] } }).lean();

  if (!flat.length) {
    console.log('\n  No flat categories left to convert — already restructured.\n');
    await mongoose.connection.close();
    return;
  }

  /* ── plan ── */
  const plan = new Map();               // group name → [{ category, count }]
  for (const cat of flat) {
    const g = groupFor(cat.name);
    const count = await Product.countDocuments({ category: cat._id });
    if (!plan.has(g.name)) plan.set(g.name, []);
    plan.get(g.name).push({ cat, count });
  }

  console.log('\n  PLAN\n  ────');
  let totalProducts = 0;
  for (const g of GROUPS) {
    const subs = plan.get(g.name);
    if (!subs?.length) continue;
    const n = subs.reduce((a, s) => a + s.count, 0);
    totalProducts += n;
    console.log(`\n  ${g.name}  (${n} products, ${subs.length} subcategories)`);
    subs.sort((a, b) => b.count - a.count)
      .forEach((s) => console.log(`      ${String(s.count).padStart(4)}  ${s.cat.name}`));
  }
  console.log(`\n  ${totalProducts} products across ${flat.length} subcategories\n`);
  console.log('  Product slugs are NOT modified — every /products/<slug> link keeps working.\n');

  if (DRY) {
    console.log('  --dry: nothing written.\n');
    await mongoose.connection.close();
    return;
  }

  /* ── 1. top-level categories ── */
  const topByName = new Map();
  for (const [i, g] of GROUPS.entries()) {
    if (!plan.get(g.name)?.length) continue;
    let doc = await Category.findOne({ name: g.name });
    if (!doc) {
      doc = await Category.create({
        name: g.name,
        slug: toSlug(g.name),
        description: g.description,
        color: g.color,
        order: i,
        isActive: true,
        showOnHomepage: true,
        isFeatured: true,
      });
      console.log(`  + category     ${g.name}`);
    }
    topByName.set(g.name, doc);
  }

  /* ── 2. flat categories → subcategories, and move their products ── */
  let moved = 0;
  for (const [groupName, subs] of plan) {
    const parent = topByName.get(groupName);

    for (const [i, { cat, count }] of subs.entries()) {
      let sub = await SubCategory.findOne({ name: cat.name, category: parent._id });
      if (!sub) {
        /* Subcategory slugs are globally unique; a name can collide with a
           product or category slug, so suffix on clash rather than throw. */
        let slug = toSlug(cat.name) || `sub-${i}`;
        let n = 1;
        // eslint-disable-next-line no-await-in-loop
        while (await SubCategory.exists({ slug })) { n += 1; slug = `${toSlug(cat.name)}-${n}`; }

        sub = await SubCategory.create({
          name: cat.name,
          slug,
          category: parent._id,
          categorySlug: parent.slug,
          description: cat.description || '',
          image: cat.image,
          banner: cat.banner,
          icon: cat.icon,
          order: i,
          isActive: true,
        });
      }

      /* Re-point the products. `slug` is deliberately absent from this update. */
      const res = await Product.updateMany(
        { category: cat._id },
        {
          category: parent._id,
          categorySlug: parent.slug,
          categoryName: parent.name,
          subCategory: sub._id,
          subCategorySlug: sub.slug,
          subCategoryName: sub.name,
        },
      );
      moved += res.modifiedCount;

      await SubCategory.updateOne({ _id: sub._id }, { productCount: count });
      await Category.deleteOne({ _id: cat._id });        // the old flat entry
    }
  }

  /* ── 3. counts ── */
  for (const doc of topByName.values()) {
    const n = await Product.countDocuments({ category: doc._id, isActive: true });
    await Category.updateOne({ _id: doc._id }, { productCount: n });
  }

  console.log(`\n  Done. ${moved} products re-pointed, ${flat.length} subcategories created.`);
  console.log('  No product slug was modified.\n');

  await mongoose.connection.close();
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
