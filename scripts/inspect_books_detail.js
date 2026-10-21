const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function check() {
  await mongoose.connect(process.env.MONGO_URI);
  const Product = mongoose.model('Product', new mongoose.Schema({}, { strict: false }));

  const searchTerms = [
    { name: 'CTET Sachin Choudhary', terms: ['sachin', 'ctet'] },
    { name: 'Drishti Science & Tech', terms: ['drishti', 'science'] },
    { name: 'Drishti Geography', terms: ['drishti', 'geography'] },
    { name: 'Drishti Itihas Sanskriti', terms: ['drishti', 'itihas'] },
    { name: 'Edu Teria Current Affairs', terms: ['edu teria', 'eduteria', 'power book'] },
    { name: 'PW NEET Physics', terms: ['pw', 'neet', 'physics wallah', '38 years'] },
    { name: 'Exampedia MP Current Affairs 2026', terms: ['exampedia', 'current affairs'] }
  ];

  console.log('--- CHECKING SCREENSHOT BOOKS IN DB ---');
  for (const item of searchTerms) {
    const query = {
      $and: item.terms.map(t => ({
        $or: [
          { title: { $regex: t, $options: 'i' } },
          { slug: { $regex: t, $options: 'i' } }
        ]
      }))
    };
    const found = await Product.find(query).select('title slug category subcategory language price mrp images description').lean();
    console.log(`\nResult for [${item.name}]: found ${found.length}`);
    found.forEach(p => {
      console.log(`  Title: ${p.title}`);
      console.log(`  Slug: ${p.slug}`);
      console.log(`  Category: ${p.category} | Sub: ${p.subcategory} | Language: ${p.language}`);
    });
  }

  console.log('\n--- CHECKING THE 3 USER PROVIDED LINKS ---');
  const userSlugs = [
    'pre-selection-tak-mpgs-2027-general-studies-for-mppsc-and-mpesb-exams-madhya-pradesh-gs-book-latest-edition-by-selection-tak-publication',
    'geography-marathon-topicwise-solved-pyqs-or-or-for-assistant-professor-net-set-1st-grade-pgt-tgt-gic-gdc-and-lt-grade-exams-or-by-dr-suraj-solanki-or-hindi-medium',
    'madhya-pradesh-general-knowledge-2nd-edition-by-disha-publication-complete-mp-gk-book-for-mppsc'
  ];

  for (const s of userSlugs) {
    const p = await Product.findOne({ slug: s }).lean();
    if (p) {
      console.log(`\nSlug: ${s}`);
      console.log(`  Title: ${p.title}`);
      console.log(`  Category: ${p.category} | Sub: ${p.subcategory} | Language: ${p.language}`);
      console.log(`  Price: ${p.price} | MRP: ${p.mrp}`);
      console.log(`  seoTitle: ${p.seoTitle}`);
      console.log(`  seoDescription: ${p.seoDescription}`);
      console.log(`  seoKeywords: ${p.seoKeywords}`);
      console.log(`  Image count: ${p.images?.length}`);
      if (p.images && p.images[0]) {
        console.log(`  Image[0] alt: ${p.images[0].alt}`);
      }
      console.log(`  Desc preview: ${(p.description || '').slice(0, 150)}...`);
    } else {
      console.log(`\nSlug: ${s} NOT FOUND`);
    }
  }

  await mongoose.disconnect();
}

check().catch(console.error);
