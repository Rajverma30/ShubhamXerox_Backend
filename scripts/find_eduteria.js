const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function check() {
  await mongoose.connect(process.env.MONGO_URI);
  const Product = mongoose.model('Product', new mongoose.Schema({}, { strict: false }));
  const all = await Product.find({}).select('title slug category language').lean();

  const printMatches = (name, testFn) => {
    const list = all.filter(testFn);
    console.log(`\n=== Matches for ${name}: ${list.length} ===`);
    list.forEach(m => console.log(`  - [${m.slug}] ${m.title}`));
  };

  printMatches('Teria', p => /teria/i.test(p.title) || /teria/i.test(p.slug));
  printMatches('Power Book', p => /power/i.test(p.title) || /power/i.test(p.slug));
  printMatches('Pravin / Eduteria', p => /eduteria|edu\s*teria/i.test(p.title) || /pravin/i.test(p.title));

  await mongoose.disconnect();
}

check().catch(console.error);
