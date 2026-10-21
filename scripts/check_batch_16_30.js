const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function check() {
  await mongoose.connect(process.env.MONGO_URI);
  const Product = mongoose.model('Product', new mongoose.Schema({}, { strict: false }));
  
  // Previous 1-15 slugs:
  const done15 = [
    'parikshadham-samanya-prabandhan-book-hindi',
    'punekar-mpesb-mpsi-solved-papers-book',
    'exampedia-mpesb-samanya-prabandhan-book',
    'punekar-mpesb-group-2-sub-group-4-notes',
    'indian-geography-spiral-notes-shubham-gupta-english',
    'general-science-2000-objective-book-dev-yadav',
    'modern-indian-history-shubham-gupta-hindi',
    'punekar-mpesb-patwari-solved-papers-book',
    'madhya-pradesh-parikshadham-mpgk-5th-edition-book',
    'exampedia-mppsc-pyqs-gs-paper-1-solved-book',
    'ancient-indian-history-shubham-gupta-hindi',
    'indian-geography-spiral-notes-shubham-gupta-hindi',
    'computer-parikshadham-praveen-sahu-book',
    'modern-indian-history-shubham-gupta-english',
    'indian-polity-laxmikanth-8th-edition-hindi'
  ];

  const all = await Product.find({ slug: { $nin: done15 } })
    .select('title slug category price mrp images description shortDescription')
    .lean();

  console.log('Total other products:', all.length);

  // Let's filter top popular exams (MPPSC, MPESB, Current Affairs, NCERT/UPSC)
  const candidates = [
    // 7 from screenshot:
    'ctet-paper-2-social-science-best-notes-updated-edition-by-sachin-choudhary-bilingual',
    'drishti-mppsc-prelims-practice-series-book-5-3rd-edition-or-includes-1450-2020-2025-pyqs-hindi-medium',
    'drishti-mppsc-prelims-practice-series-book-2-3rd-edition-or-includes-3300-2020-2025-pyqs-hindi-medium',
    'drishti-mppsc-prelims-practice-series-book-1-3rd-edition-or-includes-3300-2020-2025-pyqs-hindi-medium',
    'edu-teria-current-affairs-mcqs-power-book-june-2025-to-october-2026-hindi-medium-for-all-competitive-exams',
    'pw-neet-39-years-physics-chapter-wise-and-topic-wise-solved-papers-2026-1988',
    'exampedia-madhya-pradesh-current-affairs-yearbook-2026-hindi-medium-2026-mppsc-pre-mains-mpesb-mpsi-adpo-assistant-profe',
    // 3 from user links:
    'pre-selection-tak-mpgs-2027-general-studies-for-mppsc-and-mpesb-exams-madhya-pradesh-gs-book-latest-edition-by-selection-tak-publication',
    'geography-marathon-topicwise-solved-pyqs-or-or-for-assistant-professor-net-set-1st-grade-pgt-tgt-gic-gdc-and-lt-grade-exams-or-by-dr-suraj-solanki-or-hindi-medium',
    'madhya-pradesh-general-knowledge-2nd-edition-by-disha-publication-complete-mp-gk-book-for-mppsc',
    // Top bestsellers to make total 15 (16 to 30):
    'selection-tak-mpgk-4th-edition-madhya-pradesh-selection-tak-2026-mp-gk-2026-all-mppsc-exams-and-other-all-mp-exams-2026',
    'pratiyogita-ghatna-chakra-madhya-pradesh-current-affairs-2025-26-mp-gk-annual-book-budget-economic-survey-hindi-medium',
    'nirman-ias-mppsc-prelims-unit-7-science-environment-and-health-1400-objective-questions-english-xerox',
    'mrunal-s-economy-for-upsc-prelims-2026-27-pcb15-powerhouse-for-prelims-set-of-5-booklets-in-spiral-bound-black-and-white',
    'drishti-ias-mppsc-prelims-practice-series-book-3-bharat-evam-madhya-pradesh-ki-sanvaidhanik-vyavastha-polity-and-constitution-or-hindi-medium-or-3rd-edition'
  ];

  console.log('\n--- BATCH 16-30 BOOKS (Total: ' + candidates.length + ') ---');
  for (let i = 0; i < candidates.length; i++) {
    const slug = candidates[i];
    const p = await Product.findOne({ slug }).lean();
    if (p) {
      console.log(`${i + 16}. [${p.price} INR] ${p.title.slice(0, 70)}...`);
      console.log(`    Slug: ${p.slug}`);
    } else {
      console.log(`${i + 16}. NOT FOUND: ${slug}`);
    }
  }

  await mongoose.disconnect();
}

check().catch(console.error);
