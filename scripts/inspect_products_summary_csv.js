const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const csvPath =
  process.argv[2] ||
  'C:/Users/LOQ/Downloads/scraped_data/products_summary.csv';

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
    .filter(Boolean);
}

async function main() {
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCSV(text);
  const header = rows[0].map((h) => h.trim());
  const data = rows.slice(1).filter((r) => r.length > 1 && r.some((x) => x && String(x).trim()));
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  const skus = new Map();
  const ids = new Map();
  const dupSku = [];
  const dupId = [];
  let withImg = 0;
  let multiImg = 0;
  let totalImgUrls = 0;
  const hosts = {};

  for (const r of data) {
    const id = String(r[idx.ID] || '').trim();
    const sku = String(r[idx.SKU] || '').trim();
    const imgs = getImages(r[idx.Images]);
    if (imgs.length) withImg++;
    if (imgs.length > 1) multiImg++;
    totalImgUrls += imgs.length;
    for (const u of imgs) {
      try {
        const h = new URL(u).host;
        hosts[h] = (hosts[h] || 0) + 1;
      } catch {}
    }
    if (id) {
      if (ids.has(id)) dupId.push(id);
      else ids.set(id, r);
    }
    if (sku) {
      if (skus.has(sku)) dupSku.push(sku);
      else skus.set(sku, r);
    }
  }

  const summary = {
    file: csvPath,
    header,
    productRows: data.length,
    uniqueIds: ids.size,
    uniqueSkus: skus.size,
    duplicateIds: dupId.length,
    duplicateSkus: dupSku.length,
    withImages: withImg,
    withoutImages: data.length - withImg,
    multiImageProducts: multiImg,
    totalImageUrls: totalImgUrls,
    imageHosts: hosts,
  };

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.log(JSON.stringify({ ...summary, dbCompare: 'skipped (no MONGO_URI)' }, null, 2));
    return;
  }

  await mongoose.connect(uri);
  const col = mongoose.connection.db.collection('products');
  const dbProducts = await col
    .find({}, { projection: { _id: 1, sku: 1, title: 1, slug: 1, images: 1 } })
    .toArray();

  const dbById = new Map(dbProducts.map((p) => [String(p._id), p]));
  const dbBySku = new Map(
    dbProducts.filter((p) => p.sku).map((p) => [String(p.sku).trim(), p])
  );

  let matchById = 0;
  let matchBySkuOnly = 0;
  let csvOnly = 0;
  let canRestoreImages = 0; // csv has image, db empty or missing
  let alreadyHasImages = 0;
  let idMatchButNoSku = 0;
  const restoreSamples = [];

  for (const r of data) {
    const id = String(r[idx.ID] || '').trim();
    const sku = String(r[idx.SKU] || '').trim();
    const imgs = getImages(r[idx.Images]);
    let db = id ? dbById.get(id) : null;
    let how = 'id';
    if (!db && sku) {
      db = dbBySku.get(sku);
      how = 'sku';
    }
    if (!db) {
      csvOnly++;
      continue;
    }
    if (how === 'id') matchById++;
    else matchBySkuOnly++;
    if (!sku && how === 'id') idMatchButNoSku++;

    const dbImgs = Array.isArray(db.images)
      ? db.images.filter((x) => x && (x.url || typeof x === 'string'))
      : [];
    if (imgs.length && dbImgs.length === 0) {
      canRestoreImages++;
      if (restoreSamples.length < 8) {
        restoreSamples.push({
          id: String(db._id),
          sku: db.sku || sku,
          title: String(db.title || r[idx.Title] || '').slice(0, 70),
          matchBy: how,
          csvImage: imgs[0],
        });
      }
    } else if (imgs.length && dbImgs.length > 0) {
      alreadyHasImages++;
    }
  }

  const csvIds = new Set([...ids.keys()]);
  const dbOnly = dbProducts.filter((p) => !csvIds.has(String(p._id))).length;

  console.log(
    JSON.stringify(
      {
        ...summary,
        dbCompare: {
          currentDbCount: dbProducts.length,
          matchedById: matchById,
          matchedBySkuOnly: matchBySkuOnly,
          onlyInCsv: csvOnly,
          onlyInDb: dbOnly,
          csvHasImage_dbEmpty: canRestoreImages,
          csvHasImage_dbAlreadyHas: alreadyHasImages,
          restoreSamples,
        },
        verdict:
          canRestoreImages > 0
            ? `CSV has usable cover URLs for ~${canRestoreImages} DB products that currently have no images.`
            : 'No restoreable image matches found (or DB already has images).',
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
