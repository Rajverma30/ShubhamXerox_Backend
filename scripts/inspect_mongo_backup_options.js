/**
 * Read-only inspection of current MongoDB (NOT a historical restore).
 * Uses MONGO_URI from .env only. Never prints credentials.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

function redact(msg) {
  return String(msg || '').replace(/mongodb(\+srv)?:\/\/[^@\s]+@/gi, 'mongodb$1://***:***@');
}

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.log(JSON.stringify({ ok: false, error: 'MONGO_URI missing in .env' }));
    process.exit(1);
  }

  const host = (uri.match(/@([^/]+)\//) || [])[1] || '(unknown)';
  const dbFromUri = (uri.match(/\.net\/([^?]+)/) || [])[1] || '(unknown)';

  const c = await mongoose.createConnection(uri).asPromise();
  let version = null;
  try {
    version = (await c.db.admin().buildInfo()).version;
  } catch (_) {}

  const cols = await c.db.listCollections().toArray();
  const counts = {};
  for (const col of cols) {
    counts[col.name] = await c.db.collection(col.name).countDocuments();
  }

  const products = c.db.collection('products');
  const withImages = await products.countDocuments({ 'images.0': { $exists: true } });
  const emptyImages = await products.countDocuments({
    $or: [{ images: { $size: 0 } }, { images: { $exists: false } }],
  });
  const oldestUpd = await products.find({ updatedAt: { $exists: true } }).sort({ updatedAt: 1 }).limit(1).project({ updatedAt: 1 }).toArray();
  const newestUpd = await products.find({ updatedAt: { $exists: true } }).sort({ updatedAt: -1 }).limit(1).project({ updatedAt: 1 }).toArray();

  // Local backup search (project only)
  const root = path.resolve(__dirname, '../..');
  const backupHits = [];
  function walk(dir, depth) {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (/dump|backup|mongodump|snapshot/i.test(ent.name)) {
          backupHits.push({ path: full, type: 'dir' });
        }
        walk(full, depth + 1);
      } else if (/\.(bson|archive|gz)$/i.test(ent.name) || /mongodump/i.test(ent.name)) {
        const st = fs.statSync(full);
        backupHits.push({ path: full, type: 'file', bytes: st.size, mtime: st.mtime.toISOString() });
      }
    }
  }
  walk(root, 0);

  console.log(JSON.stringify({
    ok: true,
    connection: {
      host,
      databaseFromUri: dbFromUri,
      connectedDatabase: c.name || c.db.databaseName,
      mongoVersion: version,
      accessConfirmed: (c.name || c.db.databaseName) === 'subhamxerox' || dbFromUri === 'subhamxerox',
    },
    currentLiveStateOnly: {
      collections: Object.keys(counts).sort(),
      counts,
      productsWithImages: withImages,
      productsWithoutImages: emptyImages,
      oldestProductUpdatedAtUTC: oldestUpd[0]?.updatedAt || null,
      newestProductUpdatedAtUTC: newestUpd[0]?.updatedAt || null,
      warning: 'This reflects CURRENT production data, NOT 2026-09-14 morning.',
    },
    localBackupSearchInRepo: {
      hits: backupHits.slice(0, 50),
      foundHistoricalSep14Morning: false,
    },
    atlasBackup: {
      atlasCliInstalled: false,
      atlasApiKeysInEnv: false,
      note: 'Cannot query Atlas Cloud Backup / PITR without Atlas CLI login or API keys in this environment.',
    },
  }, null, 2));

  await c.close();
})().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: redact(e.message) }));
  process.exit(1);
});
