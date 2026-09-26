/**
 * Compare current DB products vs products_date_13_14.json for duplicates / growth.
 * Read-only. Uses MONGO_URI from .env. Never prints credentials.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

function oid(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (v.$oid) return v.$oid;
  return String(v);
}

(async () => {
  const file = path.resolve(__dirname, '../../products_date_13_14.json');
  const oldArr = JSON.parse(fs.readFileSync(file, 'utf8'));
  const oldById = new Map();
  const oldBySlug = new Map();
  const oldBySku = new Map();
  for (const p of oldArr) {
    const id = oid(p._id);
    if (id) oldById.set(id, p);
    if (p.slug) oldBySlug.set(String(p.slug).toLowerCase(), p);
    if (p.sku) oldBySku.set(String(p.sku).toLowerCase(), p);
  }

  await mongoose.connect(process.env.MONGO_URI);
  const col = mongoose.connection.db.collection('products');
  const now = await col.find({}).project({
    _id: 1, title: 1, slug: 1, sku: 1, createdAt: 1, updatedAt: 1, isActive: 1, isHidden: 1,
  }).toArray();

  // Duplicate detection in CURRENT db
  const bySlug = new Map();
  const bySku = new Map();
  const byTitle = new Map();
  for (const p of now) {
    const slug = (p.slug || '').toLowerCase();
    const sku = (p.sku || '').toLowerCase();
    const title = (p.title || '').trim().toLowerCase();
    if (slug) {
      if (!bySlug.has(slug)) bySlug.set(slug, []);
      bySlug.get(slug).push(p);
    }
    if (sku) {
      if (!bySku.has(sku)) bySku.set(sku, []);
      bySku.get(sku).push(p);
    }
    if (title) {
      if (!byTitle.has(title)) byTitle.set(title, []);
      byTitle.get(title).push(p);
    }
  }

  const dupSlug = [...bySlug.entries()].filter(([, a]) => a.length > 1);
  const dupSku = [...bySku.entries()].filter(([, a]) => a.length > 1);
  const dupTitle = [...byTitle.entries()].filter(([, a]) => a.length > 1);

  // Overlap with Sep 13/14 dump
  let sameId = 0;
  let onlyInNow = 0;
  let onlyInOld = 0;
  const newSamples = [];
  const nowIds = new Set(now.map((p) => String(p._id)));

  for (const p of now) {
    if (oldById.has(String(p._id))) sameId += 1;
    else {
      onlyInNow += 1;
      if (newSamples.length < 15) {
        newSamples.push({
          title: (p.title || '').slice(0, 55),
          slug: p.slug,
          sku: p.sku,
          createdAt: p.createdAt,
        });
      }
    }
  }
  for (const id of oldById.keys()) {
    if (!nowIds.has(id)) onlyInOld += 1;
  }

  // createdAt buckets for "new" products
  const createdBuckets = { beforeSep14: 0, onOrAfterSep14: 0, unknown: 0 };
  const sep14 = new Date('2026-09-14T00:00:00.000+05:30');
  for (const p of now) {
    if (!oldById.has(String(p._id))) {
      if (!p.createdAt) createdBuckets.unknown += 1;
      else if (new Date(p.createdAt) >= sep14) createdBuckets.onOrAfterSep14 += 1;
      else createdBuckets.beforeSep14 += 1;
    }
  }

  console.log(JSON.stringify({
    counts: {
      oldDump_13_14: oldArr.length,
      currentDb: now.length,
      difference: now.length - oldArr.length,
      same_id_in_both: sameId,
      only_in_current_db: onlyInNow,
      only_in_old_dump_missing_now: onlyInOld,
    },
    duplicates_in_current_db: {
      duplicate_slugs_groups: dupSlug.length,
      duplicate_skus_groups: dupSku.length,
      duplicate_exact_titles_groups: dupTitle.length,
      duplicate_slug_examples: dupSlug.slice(0, 8).map(([slug, arr]) => ({
        slug,
        count: arr.length,
        titles: arr.map((x) => (x.title || '').slice(0, 40)),
        ids: arr.map((x) => String(x._id)),
      })),
      duplicate_sku_examples: dupSku.slice(0, 8).map(([sku, arr]) => ({
        sku,
        count: arr.length,
        titles: arr.map((x) => (x.title || '').slice(0, 40)),
      })),
      duplicate_title_examples: dupTitle.slice(0, 8).map(([title, arr]) => ({
        title: title.slice(0, 50),
        count: arr.length,
        slugs: arr.map((x) => x.slug),
      })),
    },
    newProductsNotInOldDump: {
      createdAtRelativeToSep14IST: createdBuckets,
      samples: newSamples,
    },
    verdict:
      dupSlug.length === 0 && dupSku.length === 0
        ? 'No duplicate slug/sku in current DB. Growth looks like added products (or dump was partial), not duplicates.'
        : 'Duplicates found — see duplicate_* fields.',
  }, null, 2));

  await mongoose.disconnect();
})().catch((e) => {
  console.error(String(e.message || e).replace(/mongodb(\+srv)?:\/\/[^@]+@/gi, 'mongodb$1://***@'));
  process.exit(1);
});
