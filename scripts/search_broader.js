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
    list.slice(0, 10).forEach(m => console.log(`  - [${m.slug}] ${m.title}`));
  };

  printMatches('Sachin', p => /sachin/i.test(p.title) || /sachin/i.test(p.slug));
  printMatches('CTET / TET', p => /ctet|tet|pedagogy|teaching/i.test(p.title) || /ctet|tet/i.test(p.slug));
  printMatches('Social Science / Samajik', p => /samajik|social\s*science/i.test(p.title) || /social/i.test(p.slug));
  printMatches('Edu Teria / Eduteria / Edu', p => /eduteria|edu\s*teria|power\s*book|teria/i.test(p.title) || /teria/i.test(p.slug));
  printMatches('Current Affairs', p => /current\s*affairs|varshikank|samayiki/i.test(p.title));

  await mongoose.disconnect();
}

check().catch(console.error);
