/**
 * SEO endpoints: sitemap.xml, robots.txt, JSON-LD schema, and bot pre-rendering.
 * The storefront proxies /sitemap.xml and /robots.txt to these routes so the
 * generated content always reflects the live catalogue.
 */
const axios = require('axios');
const sharp = require('sharp');
const { Product, Category, SubCategory, Setting } = require('../models');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');
const { resolveLegacy } = require('./legacy.controller');

const FRONTEND = () => {
  let url = (process.env.FRONTEND_URL || 'https://shubhamxerox.in').replace(/\/$/, '');
  if (url.includes('web.app') || url.includes('localhost')) {
    url = 'https://shubhamxerox.in';
  }
  return url;
};

const esc = (s = '') => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const urlNode = ({ loc, lastmod, changefreq = 'weekly', priority = 0.6 }) =>
  `  <url><loc>${esc(loc)}</loc>${lastmod ? `<lastmod>${new Date(lastmod).toISOString()}</lastmod>` : ''}` +
  `<changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`;

/** GET /sitemap.xml */
exports.sitemap = asyncHandler(async (_req, res) => {
  const base = FRONTEND();
  const [products, categories, subCategories] = await Promise.all([
    Product.find({ isActive: true, isHidden: false }).select('slug updatedAt').limit(20000).lean(),
    Category.find({ isActive: true }).select('slug updatedAt').lean(),
    SubCategory.find({ isActive: true }).select('slug updatedAt').lean(),
  ]);

  const staticPages = [
    '',
    '/shop',
    '/categories',
    '/category/mppsc-books',
    '/category/mppsc-mains-books',
    '/category/mpesb-books',
    '/category/current-affairs-books',
    '/category/ghatna-chakra-books',
    '/ebooks',
    '/stationery',
    '/offers',
    '/about',
    '/contact',
    '/store-indore',
  ];

  const nodes = [
    ...staticPages.map((p) => urlNode({ loc: `${base}${p}`, changefreq: p === '' ? 'daily' : 'weekly', priority: p === '' ? 1.0 : 0.8 })),
    ...categories.map((c) => urlNode({ loc: `${base}/category/${c.slug}`, lastmod: c.updatedAt, priority: 0.8 })),
    ...subCategories.map((s) => urlNode({ loc: `${base}/collection/${s.slug}`, lastmod: s.updatedAt, priority: 0.7 })),
    ...products.map((p) => urlNode({ loc: `${base}/product/${p.slug}`, lastmod: p.updatedAt, changefreq: 'weekly', priority: 0.6 })),
  ];

  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${nodes.join('\n')}\n</urlset>`,
  );
});

/** GET /robots.txt */
exports.robots = asyncHandler(async (_req, res) => {
  const settings = await Setting.getSingleton();
  const base = FRONTEND();
  const body = settings.maintenanceMode
    ? `User-agent: *\nDisallow: /\n`
    : [
        'User-agent: *',
        'Allow: /',
        'Disallow: /cart',
        'Disallow: /checkout',
        'Disallow: /order-placed',
        'Disallow: /admin',
        'Disallow: /wishlist',
        'Disallow: /track',
        'Disallow: /policy/',
        '',
        `Sitemap: ${base}/sitemap.xml`,
        '',
      ].join('\n');
  res.type('text/plain').send(body);
});

/** GET /api/seo/product/:slug — JSON-LD for the product page. */
exports.productSchema = asyncHandler(async (req, res) => {
  const p = await Product.findOne({ slug: req.params.slug, isActive: true }).lean();
  if (!p) return ok(res, null);
  const base = FRONTEND();

  return ok(res, {
    '@context': 'https://schema.org',
    '@type': p.type === 'stationery' ? 'Product' : 'Book',
    name: p.title,
    image: (p.images || []).map((i) => i.url),
    description: p.shortDescription || String(p.description || '').replace(/<[^>]+>/g, '').slice(0, 300),
    sku: p.sku,
    ...(p.isbn ? { isbn: p.isbn } : {}),
    ...(p.author ? { author: { '@type': 'Person', name: p.author } } : {}),
    ...(p.publisher ? { publisher: { '@type': 'Organization', name: p.publisher } } : {}),
    ...(p.pages ? { numberOfPages: p.pages } : {}),
    inLanguage: p.language,
    brand: { '@type': 'Brand', name: p.brand || 'Shubham Xerox' },
    offers: {
      '@type': 'Offer',
      url: `${base}/product/${p.slug}`,
      priceCurrency: p.currency || 'INR',
      price: p.finalPrice || p.price,
      availability: p.stock > 0 || p.type === 'ebook' ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      seller: { '@type': 'Organization', name: 'Shubham Xerox' },
    },
    ...(p.rating?.count
      ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: p.rating.average, reviewCount: p.rating.count } }
      : {}),
  });
});

/** GET /api/og/product/:slug — Crawlable HTML & Open Graph pre-renderer for bots/crawlers. */
exports.productOg = asyncHandler(async (req, res) => {
  const rawSlug = String(req.params.slug || '').trim();
  const p = await Product.findOne({ slug: rawSlug }).lean();
  const base = FRONTEND();
  const targetUrl = `${base}/product/${rawSlug}`;

  // If product is not found by slug, attempt legacy URL resolution (SKU LEG-X, title, old slug)
  if (!p) {
    const legacyMatch = await resolveLegacy(rawSlug || req.originalUrl);
    if (legacyMatch && legacyMatch.product && legacyMatch.product.slug !== rawSlug) {
      return res.redirect(301, `${base}/product/${legacyMatch.product.slug}`);
    }

    // Genuine 404 for crawlers & bots with noindex
    const notFoundHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Product Not Found | Shubham Xerox</title>
  <meta name="robots" content="noindex, follow">
</head>
<body style="font-family:sans-serif;padding:40px;text-align:center;background:#f9fafb;color:#111827;">
  <h1>Product Not Found</h1>
  <p>The product you requested could not be found or has been removed.</p>
  <p><a href="${base}/shop" style="color:#2563eb;">Browse Catalogue</a> · <a href="${base}" style="color:#2563eb;">Home</a></p>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(404).send(notFoundHtml);
  }

  const finalPrice = p.finalPrice || p.price || 0;
  const mrp = p.price || finalPrice;
  const discountText = p.discountPercent > 0 ? ` (${p.discountPercent}% OFF)` : (mrp > finalPrice ? ` (Save ₹${Math.round(mrp - finalPrice)})` : '');
  const priceText = `₹${finalPrice}${discountText}`;

  const title = esc(`${p.seo?.metaTitle || p.title} — Buy Online | Shubham Xerox`);
  const rawDesc = p.shortDescription || String(p.description || '').replace(/<[^>]+>/g, '').slice(0, 280);
  const description = esc(`${priceText} · ${rawDesc || `Buy ${p.title} online at best price from Shubham Xerox Indore. Fast delivery across India.`}`);

  const backendUrl = (process.env.BACKEND_URL || 'https://subhamapi.hypernxt.space').replace(/\/$/, '');
  const ogImageUrl = esc(p.images?.[0]?.url ? (p.images[0].url.startsWith('http') ? p.images[0].url : `${backendUrl}${p.images[0].url.startsWith('/') ? '' : '/'}${p.images[0].url}`) : `${base}/logo.png`);

  const schemaJson = JSON.stringify([
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: base },
        { '@type': 'ListItem', position: 2, name: p.categoryName || 'Shop', item: `${base}/category/${p.categorySlug || 'shop'}` },
        { '@type': 'ListItem', position: 3, name: p.title, item: targetUrl },
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': p.type === 'stationery' ? 'Product' : 'Book',
      name: p.title,
      image: (p.images || []).map((i) => i.url),
      description: p.shortDescription || String(p.description || '').replace(/<[^>]+>/g, '').slice(0, 300),
      sku: p.sku,
      ...(p.isbn ? { isbn: p.isbn } : {}),
      ...(p.author ? { author: { '@type': 'Person', name: p.author } } : {}),
      ...(p.publisher ? { publisher: { '@type': 'Organization', name: p.publisher } } : {}),
      brand: { '@type': 'Brand', name: p.brand || 'Shubham Xerox' },
      offers: {
        '@type': 'Offer',
        url: targetUrl,
        priceCurrency: p.currency || 'INR',
        price: finalPrice,
        availability: p.stock > 0 || p.type === 'ebook' ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
        seller: { '@type': 'Organization', name: 'Shubham Xerox' },
      },
    },
  ]);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <link rel="canonical" href="${targetUrl}">
  <meta property="og:type" content="product">
  <meta property="og:site_name" content="Shubham Xerox">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:price:amount" content="${finalPrice}">
  <meta property="og:price:currency" content="INR">
  <meta property="product:price:amount" content="${finalPrice}">
  <meta property="product:price:currency" content="INR">
  <meta property="og:image" content="${ogImageUrl}">
  <meta property="og:url" content="${targetUrl}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="${ogImageUrl}">
  <script type="application/ld+json">${schemaJson}</script>
</head>
<body style="font-family:system-ui,sans-serif;line-height:1.6;max-width:900px;margin:0 auto;padding:20px;color:#111827;background:#ffffff;">
  <nav style="margin-bottom:20px;font-size:14px;color:#4b5563;">
    <a href="${base}" style="color:#2563eb;text-decoration:none;">Home</a> &gt;
    <a href="${base}/category/${esc(p.categorySlug || 'shop')}" style="color:#2563eb;text-decoration:none;">${esc(p.categoryName || 'Shop')}</a> &gt;
    <span>${esc(p.title)}</span>
  </nav>

  <article>
    <h1 style="font-size:28px;font-weight:700;margin-bottom:12px;color:#111827;">${esc(p.title)}</h1>
    <div style="font-size:24px;font-weight:700;color:#059669;margin-bottom:16px;">${priceText}</div>
    ${ogImageUrl ? `<img src="${ogImageUrl}" alt="${esc(p.title)}" style="max-width:320px;height:auto;border-radius:12px;margin-bottom:20px;display:block;">` : ''}
    
    <div style="margin-bottom:24px;">
      <h2 style="font-size:18px;font-weight:600;margin-bottom:8px;">Book &amp; Product Details</h2>
      <ul style="list-style:none;padding:0;font-size:15px;line-height:1.8;">
        ${p.author ? `<li><strong>Author:</strong> ${esc(p.author)}</li>` : ''}
        ${p.publisher ? `<li><strong>Publisher:</strong> ${esc(p.publisher)}</li>` : ''}
        ${p.isbn ? `<li><strong>ISBN:</strong> ${esc(p.isbn)}</li>` : ''}
        ${p.edition ? `<li><strong>Edition:</strong> ${esc(p.edition)}</li>` : ''}
        ${p.pages ? `<li><strong>Pages:</strong> ${p.pages}</li>` : ''}
        ${p.categoryName ? `<li><strong>Category:</strong> <a href="${base}/category/${esc(p.categorySlug)}">${esc(p.categoryName)}</a></li>` : ''}
        <li><strong>SKU:</strong> ${esc(p.sku || rawSlug)}</li>
        <li><strong>Availability:</strong> ${p.stock > 0 || p.type === 'ebook' ? 'In Stock' : 'Out of Stock'}</li>
      </ul>
    </div>

    <div style="margin-bottom:30px;">
      <h2 style="font-size:18px;font-weight:600;margin-bottom:8px;">Description</h2>
      <div style="font-size:15px;color:#374151;">${p.description || esc(p.shortDescription || `Buy ${p.title} online at Shubham Xerox.`)}</div>
    </div>

    <div style="border-top:1px solid #e5e7eb;padding-top:20px;font-size:14px;color:#6b7280;">
      <p>Store location: Bhawarkua Square, Main Road, Indore, Madhya Pradesh 452001.</p>
      <p><a href="${base}/category/${esc(p.categorySlug || 'shop')}" style="color:#2563eb;">Explore all ${esc(p.categoryName || 'exam books')}</a></p>
    </div>
  </article>

  <script>
    if (!/Googlebot|bingbot|TelegramBot|WhatsApp|facebookexternalhit|Twitterbot|LinkedInBot|bot|crawler|spider/i.test(navigator.userAgent)) {
      window.location.replace("${targetUrl}");
    }
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
});

/** GET /api/og/image/:slug.jpg — Dynamic JPEG image converter for Telegram/WhatsApp previews */
exports.productOgImage = asyncHandler(async (req, res) => {
  const rawSlug = String(req.params.slug || '').replace(/\.jpg$/i, '');
  const p = await Product.findOne({ slug: rawSlug }).lean();
  const base = FRONTEND();

  let rawImg = p?.images?.[0]?.url || p?.images?.[0]?.thumbUrl || '';
  if (!rawImg) {
    return res.redirect(302, `${base}/logo.png`);
  }

  if (!rawImg.startsWith('http')) {
    const backendUrl = (process.env.BACKEND_URL || 'https://subhamapi.hypernxt.space').replace(/\/$/, '');
    rawImg = `${backendUrl}${rawImg.startsWith('/') ? '' : '/'}${rawImg}`;
  }

  try {
    const response = await axios.get(rawImg, { responseType: 'arraybuffer', timeout: 8000 });
    const buffer = Buffer.from(response.data);
    const jpegBuffer = await sharp(buffer)
      .resize({ width: 800, height: 1000, fit: 'inside' })
      .jpeg({ quality: 85 })
      .toBuffer();

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    return res.send(jpegBuffer);
  } catch (err) {
    return res.redirect(302, rawImg);
  }
});
