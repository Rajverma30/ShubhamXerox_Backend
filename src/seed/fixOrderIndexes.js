#!/usr/bin/env node
/**
 * Drop stale indexes left behind by the previous Order schema.
 *
 * THE BUG THIS FIXES
 * ------------------
 *   E11000 duplicate key error … index: srOrderId_1 dup key: { srOrderId: null }
 *
 * The Shiprocket build's Order model had `srOrderId: { unique: true }`. Mongo
 * keeps an index until it is explicitly dropped — Mongoose will not remove one
 * for a field that has simply disappeared from the schema, and `autoIndex` is
 * off in production anyway.
 *
 * The new Order model has no `srOrderId`, so every document is missing it. A
 * non-sparse unique index treats "missing" as null, and permits exactly ONE
 * null. So the first order saved fine and every one after it failed.
 *
 *   npm run fix:orders -- --dry     report only
 *   npm run fix:orders              drop the stale indexes
 *   npm run fix:orders -- --purge   also delete pre-Razorpay order documents
 */
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');

const DRY = process.argv.includes('--dry');
const PURGE = process.argv.includes('--purge');

/** Fields the current Order schema actually indexes. Anything else is stale. */
const KEEP = new Set([
  '_id_',
  'orderNumber_1',
  'customer.phone_1',
  'payment.razorpayOrderId_1',
  'payment.razorpayPaymentId_1',
  'payment.status_1',
  'status_1',
  'createdAt_-1',
  'customer.phone_1_createdAt_-1',
]);

(async () => {
  await connectDB();
  const col = mongoose.connection.collection('orders');

  const exists = await mongoose.connection.db
    .listCollections({ name: 'orders' }).toArray();
  if (!exists.length) {
    console.log('\n  No `orders` collection yet — nothing to fix.\n');
    await mongoose.connection.close();
    return;
  }

  const indexes = await col.indexes();
  console.log('\n  Current indexes on `orders`:');
  indexes.forEach((i) => {
    const stale = !KEEP.has(i.name) && i.name !== '_id_';
    console.log(`    ${stale ? '✗ STALE ' : '  keep  '} ${i.name}${i.unique ? '  (unique)' : ''}`);
  });

  const stale = indexes.filter((i) => i.name !== '_id_' && !KEEP.has(i.name));

  if (!stale.length) {
    console.log('\n  No stale indexes. If orders still fail, send me the full error.\n');
  } else if (DRY) {
    console.log(`\n  --dry: would drop ${stale.length} index(es). Nothing written.\n`);
  } else {
    for (const i of stale) {
      await col.dropIndex(i.name);
      console.log(`  dropped ${i.name}`);
    }
    console.log(`\n  Dropped ${stale.length} stale index(es). Orders will save now.`);
  }

  /* Documents from the old Shiprocket flow have no orderNumber/total and will
     clutter the admin list. They are only removed when explicitly asked. */
  const legacy = await col.countDocuments({ srOrderId: { $exists: true } });
  if (legacy) {
    if (PURGE && !DRY) {
      const r = await col.deleteMany({ srOrderId: { $exists: true } });
      console.log(`  Purged ${r.deletedCount} pre-Razorpay order document(s).`);
    } else {
      console.log(`\n  ${legacy} old Shiprocket-era order document(s) present.`);
      console.log('  Re-run with --purge to remove them (they have no payment data).');
    }
  }

  console.log('');
  await mongoose.connection.close();
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
