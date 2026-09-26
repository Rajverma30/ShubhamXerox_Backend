require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const col = mongoose.connection.db.collection('products');
  const total = await col.countDocuments();
  const withImages = await col.countDocuments({ 'images.0.url': { $exists: true, $ne: '' } });
  const empty = total - withImages;

  const domains = {};
  const prefixes = {};
  const samples = [];

  const cursor = col.find({}, { projection: { title: 1, slug: 1, images: 1 } });
  while (await cursor.hasNext()) {
    const p = await cursor.next();
    const imgs = p.images || [];
    if (!imgs.length || !imgs[0]?.url) continue;
    for (const img of imgs) {
      const u = img.url || img.cardUrl || img.thumbUrl || '';
      if (!u) continue;
      try {
        const host = new URL(u).hostname;
        domains[host] = (domains[host] || 0) + 1;
      } catch {
        domains['(invalid)'] = (domains['(invalid)'] || 0) + 1;
      }
      let prefix = '(other)';
      if (u.includes('/uploads/products/')) prefix = '/uploads/products/';
      else if (u.includes('/uploads/media/')) prefix = '/uploads/media/';
      else if (u.includes('/img/products/')) prefix = '/img/products/';
      else if (u.includes('/img/')) prefix = '/img/…';
      else if (u.includes('/uploads/')) prefix = '/uploads/…';
      prefixes[prefix] = (prefixes[prefix] || 0) + 1;
    }
    if (samples.length < 12) {
      samples.push({
        title: (p.title || '').slice(0, 50),
        slug: p.slug,
        url: imgs[0].url,
        cardUrl: imgs[0].cardUrl || null,
        thumbUrl: imgs[0].thumbUrl || null,
      });
    }
  }

  console.log(JSON.stringify({
    totalProducts: total,
    withImageUrl: withImages,
    withoutImageUrl: empty,
    urlHosts: domains,
    pathPatterns: prefixes,
    samples,
  }, null, 2));

  await mongoose.disconnect();
})().catch((e) => {
  console.error(String(e.message || e).replace(/mongodb(\+srv)?:\/\/[^@]+@/gi, 'mongodb$1://***@'));
  process.exit(1);
});
