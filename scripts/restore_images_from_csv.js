/**
 * Restore product images from products_summary.csv.
 * STRICT: only exact _id match; if both have SKU they must match too.
 * Never overwrites products that already have an images[].url.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const args = process.argv.slice(2).filter((a) => a !== '--dry');
const csvPath = args[0] || 'C:/Users/LOQ/Downloads/scraped_data/products_summary.csv';
const DRY = process.argv.includes('--dry');

function parseCSV(t) {
  const rows = [];
  let row = [];
  let cell = '';
  let i = 0;
  let inQ = false;
  while (i < t.length) {
    const c = t[i];
    if (inQ) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQ = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQ = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(cell);
      cell = '';
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
      continue;
    }
    cell += c;
    i++;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function getImages(raw) {
  return String(raw || '')
    .split('|')
    .map((s) => s.trim())
    .filter((u) => /^https?:\/\//i.test(u));
}

function toImageDocs(urls, alt) {
  return urls.map((url) => ({
    url,
    cardUrl: url,
    thumbUrl: url,
    publicId: null,
    alt: alt || '',
    source: 'upload',
  }));
}

function hasDbImages(p) {
  return (p.images || []).some((img) => img && String(img.url || '').trim());
}

async function main() {
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCSV(text);
  const header = rows[0].map((h) => h.trim());
  const data = rows.slice(1).filter((r) => r.length > 1 && r.some((x) => x && String(x).trim()));
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const col = mongoose.connection.db.collection('products');

  const stats = {
    csvRows: data.length,
    csvWithImages: 0,
    skippedInvalidId: 0,
    skippedNoDbMatch: 0,
    skippedSkuMismatch: 0,
    skippedAlreadyHasImages: 0,
    skippedNoImagesInCsv: 0,
    updated: 0,
    failed: 0,
  };
  const samples = [];
  const mismatches = [];

  for (const r of data) {
    const idStr = String(r[idx.ID] || '').trim();
    const skuCsv = String(r[idx.SKU] || '').trim();
    const title = String(r[idx.Title] || '').trim();
    const urls = getImages(r[idx.Images]);

    if (!urls.length) {
      stats.skippedNoImagesInCsv++;
      continue;
    }
    stats.csvWithImages++;

    if (!mongoose.Types.ObjectId.isValid(idStr) || String(new mongoose.Types.ObjectId(idStr)) !== idStr) {
      // ObjectId.isValid accepts some non-24hex; enforce exact 24 hex
      if (!/^[a-f0-9]{24}$/i.test(idStr)) {
        stats.skippedInvalidId++;
        continue;
      }
    }
    if (!/^[a-f0-9]{24}$/i.test(idStr)) {
      stats.skippedInvalidId++;
      continue;
    }

    const _id = new mongoose.Types.ObjectId(idStr);
    const db = await col.findOne(
      { _id },
      { projection: { _id: 1, sku: 1, title: 1, images: 1 } }
    );

    if (!db) {
      stats.skippedNoDbMatch++;
      continue;
    }

    const skuDb = String(db.sku || '').trim();
    if (skuCsv && skuDb && skuCsv !== skuDb) {
      stats.skippedSkuMismatch++;
      if (mismatches.length < 10) {
        mismatches.push({ id: idStr, skuCsv, skuDb, title: title.slice(0, 60) });
      }
      continue;
    }

    if (hasDbImages(db)) {
      stats.skippedAlreadyHasImages++;
      continue;
    }

    const images = toImageDocs(urls, title.slice(0, 120));

    if (DRY) {
      stats.updated++;
      if (samples.length < 5) {
        samples.push({ id: idStr, sku: skuDb || skuCsv, title: (db.title || title).slice(0, 60), imageCount: images.length, first: urls[0] });
      }
      continue;
    }

    try {
      const res = await col.updateOne(
        {
          _id,
          $or: [
            { images: { $exists: false } },
            { images: { $size: 0 } },
            { 'images.0.url': { $exists: false } },
            { 'images.0.url': '' },
            { 'images.0.url': null },
          ],
        },
        {
          $set: {
            images,
            imagesFromPdf: false,
            updatedAt: new Date(),
          },
        }
      );
      if (res.modifiedCount === 1) {
        stats.updated++;
        if (samples.length < 5) {
          samples.push({
            id: idStr,
            sku: skuDb || skuCsv,
            title: (db.title || title).slice(0, 60),
            imageCount: images.length,
            first: urls[0],
          });
        }
      } else {
        // race / already filled between read and write
        stats.skippedAlreadyHasImages++;
      }
    } catch (e) {
      stats.failed++;
      console.error('fail', idStr, e.message);
    }
  }

  const afterWith = await col.countDocuments({ 'images.0.url': { $exists: true, $ne: '' } });
  const total = await col.countDocuments();

  console.log(
    JSON.stringify(
      {
        mode: DRY ? 'DRY_RUN' : 'APPLY',
        stats,
        skuMismatches: mismatches,
        samples,
        dbAfter: { total, withImages: afterWith, empty: total - afterWith },
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(String(e.message || e).replace(/mongodb(\+srv)?:\/\/[^@]+@/gi, 'mongodb$1://***@'));
  process.exit(1);
});
