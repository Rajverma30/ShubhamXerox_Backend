#!/usr/bin/env node
/**
 * Convert Product.language from a single string to an array.
 *
 *   npm run migrate:language -- --dry     report only, writes nothing
 *   npm run migrate:language              apply
 *
 * NON-DESTRUCTIVE. It only rewrites documents whose `language` is still a
 * string, and it only ever wraps the existing value — nothing is discarded and
 * no other field is touched. Running it twice is harmless.
 *
 * It also splits obvious multi-value strings that were already being stored as
 * one field, e.g. "Hindi & English" or "Hindi/English" → ["Hindi","English"].
 */
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');

const DRY = process.argv.includes('--dry');

/** "Hindi & English" / "Hindi, English" / "Hindi-English" → two entries. */
function split(value) {
  return String(value)
    .split(/\s*(?:&|\/|,|\band\b|\+|–|—)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\s+/g, ' '))
    .filter((s, i, a) => a.indexOf(s) === i);
}

(async () => {
  await connectDB();
  // Query the raw collection: the Mongoose schema now declares an array, which
  // would hide the string documents this migration exists to find.
  const col = mongoose.connection.collection('products');

  const stringDocs = await col.find({ language: { $type: 'string' } })
    .project({ _id: 1, title: 1, language: 1 }).toArray();

  const missing = await col.countDocuments({ language: { $exists: false } });
  const already = await col.countDocuments({ language: { $type: 'array' } });

  console.log(`\n  already arrays : ${already}`);
  console.log(`  still strings  : ${stringDocs.length}`);
  console.log(`  missing field  : ${missing}\n`);

  if (!stringDocs.length) {
    console.log('  Nothing to do.\n');
    await mongoose.connection.close();
    return;
  }

  const multi = stringDocs.filter((d) => split(d.language).length > 1);
  console.log(`  ${multi.length} will split into multiple languages:`);
  multi.slice(0, 8).forEach((d) => console.log(`    "${d.language}" -> ${JSON.stringify(split(d.language))}   ${d.title.slice(0, 40)}`));

  if (DRY) {
    console.log('\n  --dry: nothing written.\n');
    await mongoose.connection.close();
    return;
  }

  const ops = stringDocs.map((d) => ({
    updateOne: { filter: { _id: d._id }, update: { $set: { language: split(d.language) } } },
  }));

  const result = await col.bulkWrite(ops, { ordered: false });
  console.log(`\n  Updated ${result.modifiedCount} products.`);

  if (missing) {
    const r2 = await col.updateMany({ language: { $exists: false } }, { $set: { language: ['English'] } });
    console.log(`  Defaulted ${r2.modifiedCount} products with no language to ["English"].`);
  }

  console.log('  Done. Existing data preserved — only the field shape changed.\n');
  await mongoose.connection.close();
})().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
