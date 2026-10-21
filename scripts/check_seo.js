const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const Product = mongoose.model('Product', new mongoose.Schema({}, { strict: false }));

  const products = await Product.find({}).lean();
  console.log('Total products in DB:', products.length);

  const withSeo = products.filter(p => (p.seoTitle && p.seoTitle.trim()) || (p.seoDescription && p.seoDescription.trim()) || (p.metaTitle && p.metaTitle.trim()));
  console.log('Products with SEO title/description:', withSeo.length);
  withSeo.forEach((p, idx) => {
    console.log(`${idx + 1}. [${p.slug}] -> Title: ${p.title.slice(0, 50)}...`);
    console.log(`   seoTitle: ${p.seoTitle || p.metaTitle}`);
  });

  // Also check sorting by views / orders or how products are ranked
  const sorted = [...products].sort((a, b) => (b.ordersCount || 0) - (a.ordersCount || 0) || (b.viewsCount || 0) - (a.viewsCount || 0));
  console.log('\nTop 30 products by orders/views:');
  sorted.slice(0, 35).forEach((p, idx) => {
    console.log(`${idx + 1}. [Orders: ${p.ordersCount || 0}, Views: ${p.viewsCount || 0}] "${p.title.slice(0, 60)}" | slug: ${p.slug}`);
  });

  await mongoose.disconnect();
}

run().catch(console.error);
