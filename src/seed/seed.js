/**
 * Database seeder.
 *
 *   npm run seed            # wipe + populate demo catalogue
 *   npm run seed:destroy    # wipe only
 *
 * It also generates real cover artwork on disk (5 variations per title) so the
 * storefront's 5-image hover rotation and the gallery have something to show
 * before you upload your own photos or PDFs.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const path = require('path');
const fs = require('fs/promises');
const mongoose = require('mongoose');
const sharp = require('sharp');

const connectDB = require('../config/db');
const {
  Admin, Category, SubCategory, Product, Banner, Coupon, HomeSection, Setting,
  Review, Newsletter, Contact, Media, SearchHistory, Visitor,
} = require('../models');
const { toSlug } = require('../utils/slug');
const data = require('./data');
const photos = require('./images');
const logger = require('../utils/logger');

const UPLOAD_ROOT = path.join(__dirname, '..', '..', process.env.UPLOAD_DIR || 'uploads');
const BACKEND = (process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, '');

let bannerSeq = 0;

const PALETTES = [
  ['#312e81', '#6366f1'], ['#0c4a6e', '#0ea5e9'], ['#78350f', '#f59e0b'],
  ['#064e3b', '#10b981'], ['#4c0519', '#f43f5e'], ['#1e1b4b', '#8b5cf6'],
  ['#134e4a', '#14b8a6'], ['#450a0a', '#ef4444'],
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Wrap a long title into <= 4 lines for the cover art. */
function wrap(text, perLine = 18, maxLines = 4) {
  const words = String(text).split(' ');
  const lines = [];
  let line = '';
  words.forEach((w) => {
    if ((`${line} ${w}`).trim().length > perLine) {
      if (line) lines.push(line.trim());
      line = w;
    } else {
      line = `${line} ${w}`.trim();
    }
  });
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

/**
 * Cover artwork generator. `variant` 0–4 shifts the composition so the
 * hover rotation visibly changes between images.
 */
function coverSvg({ title, subtitle, badge, palette, variant }) {
  const [from, to] = palette;
  const w = 900;
  const h = 1200;
  const lines = wrap(title, variant % 2 === 0 ? 17 : 20, 4);
  const rot = [0, -4, 3, -2, 5][variant] || 0;
  const shapeY = [0, 120, -80, 200, 60][variant] || 0;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${from}"/><stop offset="100%" stop-color="${to}"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="60%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <g transform="translate(0 ${shapeY})" opacity="0.28">
    <circle cx="${variant % 2 ? 760 : 140}" cy="240" r="230" fill="#ffffff" opacity="0.16"/>
    <circle cx="${variant % 2 ? 120 : 800}" cy="980" r="300" fill="#000000" opacity="0.18"/>
    <rect x="-80" y="${520 + variant * 30}" width="1060" height="120" fill="#ffffff" opacity="0.10" transform="rotate(${rot} 450 600)"/>
  </g>
  <rect width="${w}" height="${h}" fill="url(#sheen)"/>
  <rect x="52" y="52" width="${w - 104}" height="${h - 104}" rx="26" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="3"/>
  <text x="92" y="150" font-family="Georgia, serif" font-size="34" fill="#ffffff" fill-opacity="0.9" letter-spacing="6">SUBHAM XEROX</text>
  ${badge ? `<rect x="92" y="188" rx="18" width="${Math.min(520, badge.length * 19 + 44)}" height="52" fill="#ffffff" fill-opacity="0.92"/>
  <text x="114" y="224" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="700" fill="${from}">${esc(badge.toUpperCase())}</text>` : ''}
  ${lines
    .map(
      (l, i) =>
        `<text x="92" y="${420 + i * 84}" font-family="Georgia, serif" font-size="${lines.length > 3 ? 66 : 76}" font-weight="700" fill="#ffffff">${esc(l)}</text>`,
    )
    .join('\n  ')}
  ${subtitle ? `<text x="92" y="${440 + lines.length * 84}" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="#ffffff" fill-opacity="0.86">${esc(subtitle)}</text>` : ''}
  <text x="92" y="${h - 96}" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#ffffff" fill-opacity="0.7">Page ${variant + 1} preview</text>
</svg>`;
}

/**
 * Renders one cover at 3 sizes and returns an image sub-document.
 *
 * Rasterising SVG needs librsvg support inside sharp's libvips. The prebuilt
 * sharp binaries include it, but if it's ever missing we fall back to writing
 * the .svg itself — browsers render SVG in <img> natively, so the storefront
 * still shows real artwork instead of empty placeholders.
 */
async function writeCover(basename, svg, alt, composed = null) {
  const dir = path.join(UPLOAD_ROOT, 'products');
  await fs.mkdir(dir, { recursive: true });
  // `composed` is a real photograph with branded artwork over it; `svg` is the
  // generated fallback used when no photo could be fetched.
  const buf = composed || Buffer.from(svg);

  const targets = [
    { suffix: '', width: 1400, quality: 82 },
    { suffix: '-card', width: 600, quality: 82 },
    { suffix: '-thumb', width: 160, quality: 68 },
  ];

  try {
    await Promise.all(
      targets.map((t) =>
        sharp(buf, composed ? {} : { density: 150 })
          .resize({ width: t.width })
          .webp({ quality: t.quality })
          .toFile(path.join(dir, `${basename}${t.suffix}.webp`)),
      ),
    );

    return {
      url: `${BACKEND}/uploads/products/${basename}.webp`,
      cardUrl: `${BACKEND}/uploads/products/${basename}-card.webp`,
      thumbUrl: `${BACKEND}/uploads/products/${basename}-thumb.webp`,
      alt,
      width: 1400,
      height: 1867,
      source: 'upload',
    };
  } catch (err) {
    if (!writeCover.warned) {
      logger.warn(`sharp could not rasterise SVG (${err.message}) — writing .svg covers instead.`);
      writeCover.warned = true;
    }
    await fs.writeFile(path.join(dir, `${basename}.svg`), svg);
    const url = `${BACKEND}/uploads/products/${basename}.svg`;
    return { url, cardUrl: url, thumbUrl: url, alt, width: 900, height: 1200, source: 'upload' };
  }
}

/** Wide gradient artwork for hero / offer banners and category headers. */
async function writeBanner(basename, { title, subtitle, eyebrow, palette }) {
  const dir = path.join(UPLOAD_ROOT, 'banners');
  await fs.mkdir(dir, { recursive: true });
  const [from, to] = palette;
  const composed = await photos.composeBanner({ photoIndex: bannerSeq++, title, subtitle, eyebrow, palette: [from, to] });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="760" viewBox="0 0 1920 760">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${from}"/><stop offset="100%" stop-color="${to}"/></linearGradient>
    <radialGradient id="glow" cx="0.78" cy="0.3" r="0.6">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1920" height="760" fill="url(#g)"/>
  <rect width="1920" height="760" fill="url(#glow)"/>
  <g opacity="0.16" fill="#ffffff">
    <circle cx="1560" cy="180" r="200"/><circle cx="1780" cy="560" r="140"/><circle cx="1320" cy="640" r="90"/>
  </g>
  <g opacity="0.10" fill="none" stroke="#ffffff" stroke-width="2">
    ${Array.from({ length: 9 }, (_, i) => `<rect x="${1180 + i * 62}" y="${300 - i * 12}" width="46" height="${240 + i * 14}" rx="6"/>`).join('')}
  </g>
  ${eyebrow ? `<text x="120" y="270" font-family="Helvetica, Arial, sans-serif" font-size="30" letter-spacing="8" fill="#ffffff" fill-opacity="0.8">${esc(eyebrow.toUpperCase())}</text>` : ''}
  ${wrap(title, 26, 2).map((l, i) => `<text x="120" y="${370 + i * 86}" font-family="Georgia, serif" font-size="78" font-weight="700" fill="#ffffff">${esc(l)}</text>`).join('\n  ')}
  ${subtitle ? `<text x="120" y="${400 + wrap(title, 26, 2).length * 86}" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="#ffffff" fill-opacity="0.85">${esc(subtitle)}</text>` : ''}
</svg>`;

  try {
    await Promise.all([
      sharp(Buffer.from(svg), { density: 150 }).resize({ width: 1024 }).webp({ quality: 80 }).toFile(path.join(dir, `${basename}-card.webp`)),
      sharp(Buffer.from(svg), { density: 150 }).resize({ width: 900, height: 900, fit: 'cover', position: 'left' }).webp({ quality: 80 }).toFile(path.join(dir, `${basename}-mobile.webp`)),
    ]);

    return {
      desktop: { url: `${BACKEND}/uploads/banners/${basename}.webp`, cardUrl: `${BACKEND}/uploads/banners/${basename}-card.webp`, thumbUrl: `${BACKEND}/uploads/banners/${basename}-card.webp`, alt: title, width: 1920, height: 760, source: 'upload' },
      mobile: { url: `${BACKEND}/uploads/banners/${basename}-mobile.webp`, cardUrl: `${BACKEND}/uploads/banners/${basename}-mobile.webp`, thumbUrl: `${BACKEND}/uploads/banners/${basename}-mobile.webp`, alt: title, width: 900, height: 900, source: 'upload' },
    };
  } catch (err) {
    // Same SVG fallback as writeCover — see the note there.
    await fs.writeFile(path.join(dir, `${basename}.svg`), svg);
    const url = `${BACKEND}/uploads/banners/${basename}.svg`;
    const rec = { url, cardUrl: url, thumbUrl: url, alt: title, width: 1920, height: 760, source: 'upload' };
    return { desktop: rec, mobile: { ...rec, width: 900, height: 900 } };
  }
}

async function destroy() {
  await Promise.all([
    Category.deleteMany({}), SubCategory.deleteMany({}), Product.deleteMany({}), Banner.deleteMany({}),
    Coupon.deleteMany({}), HomeSection.deleteMany({}),
    Review.deleteMany({}), Newsletter.deleteMany({}), Contact.deleteMany({}), Media.deleteMany({}),
    SearchHistory.deleteMany({}), Visitor.deleteMany({}), Setting.deleteMany({}),
  ]);
  logger.warn('All collections cleared (Admin accounts preserved)');
  await rebuildIndexes();
}

/**
 * Drop and rebuild indexes from the current schemas.
 *
 * Mongoose will not modify an index that already exists under the same name,
 * so a database created by an older version of these models can keep a stale
 * definition. Dropping first guarantees the text index picks up
 * `language_override`, without which documents whose `language` is "Hindi",
 * "Odia" or "NA" fail to insert.
 */
async function rebuildIndexes() {
  for (const Model of [Product, Category, SubCategory]) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await Model.collection.dropIndexes();
    } catch (err) {
      // 26 = NamespaceNotFound (collection doesn't exist yet) — nothing to drop.
      if (err.code !== 26) logger.debug(`dropIndexes(${Model.modelName}): ${err.message}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await Model.syncIndexes();
  }
  logger.info('Indexes rebuilt from the current schemas');
}

async function seed() {
  await destroy();

  // Fetch (or reuse the cache of) real photographs before writing any artwork.
  await photos.preparePool(path.join(UPLOAD_ROOT, 'tmp', 'photo-pool'));

  /* ── 1. admin ── */
  const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  await Admin.deleteMany({});
  await Admin.create({
    username,
    password: process.env.ADMIN_PASSWORD || 'admin',
    email: process.env.ADMIN_EMAIL || 'admin@subhamxerox.com',
    name: 'Store Admin',
    role: 'admin',
  });
  logger.info(`Admin ready → ${username} / ${process.env.ADMIN_PASSWORD || 'admin'}`);

  /* ── 2. categories + subcategories (with generated artwork) ── */
  const categoryDocs = {};
  const subDocs = {};

  for (const [ci, cat] of data.categories.entries()) {
    const slug = toSlug(cat.name);
    const palette = PALETTES[ci % PALETTES.length];
    // eslint-disable-next-line no-await-in-loop
    const art = await writeBanner(`cat-${slug}`, { title: cat.name, subtitle: cat.shortDescription, eyebrow: 'Category', palette });

    // eslint-disable-next-line no-await-in-loop
    const doc = await Category.create({
      name: cat.name,
      slug,
      icon: cat.icon,
      color: palette[1],
      order: cat.order,
      isFeatured: cat.isFeatured,
      showOnHomepage: true,
      shortDescription: cat.shortDescription,
      description: cat.description || '',
      image: art.mobile,
      banner: art.desktop,
      seo: {
        metaTitle: `${cat.name} — buy online at Shubham Xerox`,
        metaDescription: cat.shortDescription,
        metaKeywords: [cat.name.toLowerCase(), 'buy online', 'shubham xerox'],
      },
    });
    categoryDocs[cat.name] = doc;

    for (const [si, sub] of cat.subs.entries()) {
      const subSlug = toSlug(`${cat.name}-${sub.name}`);
      const subPalette = PALETTES[(ci + si + 1) % PALETTES.length];
      // eslint-disable-next-line no-await-in-loop
      const subArt = await writeBanner(`sub-${subSlug}`, { title: sub.name, subtitle: cat.name, eyebrow: 'Collection', palette: subPalette });
      // eslint-disable-next-line no-await-in-loop
      const subDoc = await SubCategory.create({
        name: sub.name,
        slug: subSlug,
        category: doc._id,
        categorySlug: doc.slug,
        order: si,
        isPopular: sub.isPopular,
        shortDescription: `${sub.name} titles and materials in ${cat.name}.`,
        image: subArt.mobile,
        banner: subArt.desktop,
        seo: { metaTitle: `${sub.name} ${cat.name} — Shubham Xerox`, metaDescription: `Shop ${sub.name} in ${cat.name} at Shubham Xerox.` },
      });
      subDocs[`${cat.name}::${sub.name}`] = subDoc;
    }
  }
  logger.info(`${Object.keys(categoryDocs).length} categories, ${Object.keys(subDocs).length} sub categories`);

  /* ── 3. products ── */
  const created = [];

  const makeProduct = async (payload, coverMeta, index, kind = 'book') => {
    const palette = PALETTES[index % PALETTES.length];
    const slug = toSlug(payload.title);

    // Five variations → powers the 5-image hover rotation on product cards.
    // Each pulls a different photograph so the rotation is visibly different.
    const images = [];
    for (let v = 0; v < 5; v += 1) {
      // eslint-disable-next-line no-await-in-loop
      const composed = await photos.composeCover({
        photoIndex: index * 5 + v,
        ...coverMeta,
        palette,
        variant: v,
        kind,
      });
      // eslint-disable-next-line no-await-in-loop
      images.push(await writeCover(
        `${slug}-${v + 1}`,
        coverSvg({ ...coverMeta, palette, variant: v }),
        `${payload.title} — view ${v + 1}`,
        composed,
      ));
    }
    return Product.create({ ...payload, slug, images });
  };

  for (const [i, b] of data.books.entries()) {
    const [title, author, publisher, catName, subName, price, discount, stock, language, pages] = b;
    const cat = categoryDocs[catName];
    const sub = subDocs[`${catName}::${subName}`];
    const hasEbook = i % 3 === 0; // every third title ships with a free ebook

    // eslint-disable-next-line no-await-in-loop
    const doc = await makeProduct(
      {
        title,
        sku: `SX-BK-${String(i + 1).padStart(4, '0')}`,
        type: hasEbook ? 'book+ebook' : 'book',
        author,
        publisher,
        isbn: `978-93-${String(10000 + i * 7).slice(0, 5)}-${String(i + 1).padStart(2, '0')}-${(i % 9) + 1}`,
        edition: `${2026 - (i % 3)} Edition`,
        language,
        pages,
        publishYear: 2026 - (i % 3),
        binding: i % 2 ? 'Paperback' : 'Hardcover',
        weight: Math.round((0.25 + pages / 2000) * 100) / 100,
        price,
        discountPercent: discount,
        stock,
        category: cat._id,
        categorySlug: cat.slug,
        categoryName: cat.name,
        subCategory: sub?._id,
        subCategorySlug: sub?.slug,
        subCategoryName: sub?.name,
        tags: [catName.toLowerCase(), subName.toLowerCase(), author.split(' ').pop().toLowerCase(), 'latest edition'],
        shortDescription: `${title} — ${publisher} ${2026 - (i % 3)} edition, ${pages} pages, ${language}.`,
        description: `<p><strong>${title}</strong> is the ${2026 - (i % 3)} edition from ${publisher}, written by ${author}.</p>
<p>It covers the complete syllabus with chapter-wise theory, solved previous-year questions and full-length practice sets. Printed on high-GSM paper with a lay-flat binding so it survives a full year of daily use.</p>
<ul><li>Complete, syllabus-mapped coverage</li><li>Solved previous-year papers with explanations</li><li>Chapter-end practice sets and mock tests</li><li>Updated current-affairs appendix</li></ul>`,
        highlights: [
          `${pages} pages, ${language}`,
          `${publisher} — ${2026 - (i % 3)} edition`,
          'Solved previous-year papers included',
          hasEbook ? 'Free ebook PDF included with purchase' : 'Fast dispatch, ships within 24 hours',
        ],
        specifications: [
          { label: 'Author', value: author },
          { label: 'Publisher', value: publisher },
          { label: 'Language', value: language },
          { label: 'Pages', value: String(pages) },
          { label: 'Binding', value: i % 2 ? 'Paperback' : 'Hardcover' },
          { label: 'Edition', value: `${2026 - (i % 3)}` },
        ],
        isFeatured: i % 4 === 0,
        isTrending: i % 3 === 1,
        isBestSeller: i % 5 === 0,
        isLatest: i < 10,
        isNewArrival: i < 6,
        soldCount: Math.round(20 + Math.random() * 400),
        views: Math.round(100 + Math.random() * 3000),
        rating: { average: Math.round((3.8 + Math.random() * 1.2) * 10) / 10, count: Math.round(4 + Math.random() * 90) },
        ...(hasEbook
          ? { ebook: { fileUrl: `${BACKEND}/uploads/ebooks/sample-${i + 1}.pdf`, filename: `sample-${i + 1}.pdf`, isFree: true, allowPreview: true, previewPages: 5, pageCount: pages, sizeBytes: 1024 * 1024 * 2, downloadCount: Math.round(Math.random() * 500) } }
          : {}),
        seo: {
          metaTitle: `${title} — buy online | Shubham Xerox`,
          metaDescription: `Buy ${title} by ${author} (${publisher}) online at ${discount}% off. Free delivery above ₹499.`,
          metaKeywords: [title.toLowerCase(), author.toLowerCase(), subName.toLowerCase()],
        },
      },
      { title, subtitle: author, badge: subName },
      i,
    );
    created.push(doc);
  }

  for (const [i, s] of data.stationery.entries()) {
    const [title, brand, subName, price, discount, stock, color] = s;
    const cat = categoryDocs.Stationery;
    const sub = subDocs[`Stationery::${subName}`];

    // eslint-disable-next-line no-await-in-loop
    const doc = await makeProduct(
      {
        title,
        sku: `SX-ST-${String(i + 1).padStart(4, '0')}`,
        type: 'stationery',
        brand,
        color,
        material: i % 2 ? 'Plastic' : 'Metal',
        weight: 0.15 + (i % 5) * 0.05,
        price,
        discountPercent: discount,
        stock,
        language: 'NA',
        category: cat._id,
        categorySlug: cat.slug,
        categoryName: cat.name,
        subCategory: sub?._id,
        subCategorySlug: sub?.slug,
        subCategoryName: sub?.name,
        tags: ['stationery', subName.toLowerCase(), brand.toLowerCase()],
        shortDescription: `${brand} ${subName.toLowerCase()} — ${color}.`,
        description: `<p><strong>${title}</strong> from ${brand}. A desk staple we restock constantly because it keeps selling out.</p>
<ul><li>Brand: ${brand}</li><li>Colour: ${color}</li><li>Genuine product with brand warranty where applicable</li></ul>`,
        highlights: [`Brand: ${brand}`, `Colour: ${color}`, 'Genuine, sealed packaging', 'Ships within 24 hours'],
        specifications: [
          { label: 'Brand', value: brand },
          { label: 'Colour', value: color },
          { label: 'Material', value: i % 2 ? 'Plastic' : 'Metal' },
          { label: 'Type', value: subName },
        ],
        isFeatured: i % 4 === 1,
        isTrending: i % 3 === 0,
        isBestSeller: i % 4 === 2,
        isLatest: i < 6,
        isNewArrival: i < 4,
        soldCount: Math.round(40 + Math.random() * 600),
        views: Math.round(80 + Math.random() * 2000),
        rating: { average: Math.round((4.0 + Math.random()) * 10) / 10, count: Math.round(6 + Math.random() * 120) },
        seo: {
          metaTitle: `${title} — buy online | Shubham Xerox`,
          metaDescription: `Buy ${title} online at ${discount}% off. Genuine ${brand} product.`,
        },
      },
      { title, subtitle: brand, badge: subName },
      i + data.books.length,
      'stationery',
    );
    created.push(doc);
  }
  const imageDir = path.join(UPLOAD_ROOT, 'products');
  const imageCount = (await fs.readdir(imageDir).catch(() => []))
    .filter((f) => f.endsWith('.webp') || f.endsWith('.svg')).length;
  logger.info(`${created.length} products · ${imageCount} image files written to ${imageDir}`);
  if (!imageCount) {
    logger.warn('No cover images were generated — check that sharp installed correctly (npm rebuild sharp).');
  } else {
    logger.info(photos.hasPhotos()
      ? 'Covers composed from real photographs (stock imagery — replace with the client\'s own before launch).'
      : 'Covers generated from vector artwork (no photos available).');
  }

  /* ── 4. banners ── */
  for (const [i, b] of data.banners.entries()) {
    const palette = b.gradient || PALETTES[i % PALETTES.length];
    // eslint-disable-next-line no-await-in-loop
    const art = await writeBanner(`banner-${i + 1}-${toSlug(b.title).slice(0, 30)}`, { ...b, palette });
    // eslint-disable-next-line no-await-in-loop
    await Banner.create({
      placement: b.placement,
      eyebrow: b.eyebrow,
      title: b.title,
      subtitle: b.subtitle,
      buttonText: b.buttonText,
      buttonUrl: b.buttonUrl,
      secondaryButtonText: b.secondaryButtonText,
      secondaryButtonUrl: b.secondaryButtonUrl,
      priority: b.priority,
      theme: b.theme || 'dark',
      image: art.desktop,
      tabletImage: art.desktop,
      mobileImage: art.mobile,
      isActive: true,
    });
  }
  logger.info(`${data.banners.length} banners`);

  /* ── 5. coupons ── */
  await Coupon.insertMany(
    data.coupons.map((c) => ({
      ...c,
      isActive: true,
      showOnSite: true,
      startsAt: new Date(),
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    })),
  );

  /* ── 6. homepage sections ── */
  await HomeSection.insertMany(data.homeSections.map((s) => ({ ...s, isActive: true })));

  /* ── 7. settings ── */
  await Setting.deleteMany({});
  await Setting.create({
    singleton: 'global',
    storeName: 'Shubham Xerox',
    tagline: 'Books, Exam Guides & Stationery',
    logo: '/logo.png',
    email: process.env.STORE_EMAIL || 'support@shubhamxerox.com',
    phone: process.env.STORE_PHONE || '+91 99999 99999',
    whatsapp: process.env.STORE_PHONE || '+91 99999 99999',
    address: process.env.STORE_ADDRESS || 'Plot No 1, Market Building, Bhubaneswar, Odisha 751001',
    openingHours: 'Mon–Sat, 9:00 AM – 8:00 PM',
    social: { facebook: 'https://facebook.com', instagram: 'https://instagram.com', youtube: 'https://youtube.com', telegram: 'https://telegram.org' },
    taxPercent: 0,
    shippingFlat: 49,
    freeShippingAbove: 499,
    codEnabled: true,
    prepaidEnabled: true,
    announcementBar: { enabled: true, text: 'Free delivery on orders above ₹499 · Free ebook with selected guides', url: '/offers' },
    testimonials: data.testimonials,
    footerLinks: data.footerLinks,
    popularSearches: data.popularSearches,
    policies: {
      about: '<p>Shubham Xerox has been serving students, teachers and offices for over a decade. What began as a neighbourhood photocopy shop is now a full book store stocking exam guides, school textbooks and stationery — with the same fast, honest service.</p>',
      shipping: '<p>Orders are dispatched within 24 hours on business days and delivered across India via Shiprocket partner couriers. Delivery typically takes 2–6 days depending on your PIN code. Shipping is free on orders above ₹499.</p>',
      returns: '<p>If a book arrives damaged or is the wrong title, tell us within 7 days of delivery and we will replace it or refund you in full. Digital ebook downloads are non-refundable.</p>',
      privacy: '<p>We collect only the details needed to fulfil your order — name, phone, email and delivery address. We never sell your data. Payments and shipping are handled by our partners under their own privacy terms.</p>',
      terms: '<p>By placing an order you confirm the details you have entered are accurate. Prices and stock are subject to change. Free ebooks are licensed for personal use only.</p>',
    },
    seo: {
      metaTitle: 'Shubham Xerox — Books, Exam Guides & Stationery Online',
      metaDescription: 'Buy exam books, school textbooks, ebooks and stationery online at Shubham Xerox. Guest checkout, free delivery above ₹499, free ebooks with selected guides.',
      metaKeywords: ['book store', 'exam books', 'school books', 'stationery', 'odisha', 'shubham xerox'],
    },
  });

  /* ── 8. search history + newsletter + a sample review ── */
  await SearchHistory.insertMany(
    data.popularSearches.map((term, i) => ({
      term,
      count: 200 - i * 12,
      resultCount: 5 + i,
      hasNoResults: false,
      lastSearchedAt: new Date(),
    })),
  );
  await Newsletter.insertMany([
    { email: 'ananya@example.com', name: 'Ananya', source: 'footer' },
    { email: 'rohit@example.com', name: 'Rohit', source: 'popup' },
  ]);
  await Review.insertMany(
    created.slice(0, 6).map((p, i) => ({
      product: p._id,
      name: ['Ananya P.', 'Rohit S.', 'Sunita D.', 'Debasis N.', 'Priya M.', 'Kunal B.'][i],
      email: `reviewer${i}@example.com`,
      rating: 5 - (i % 2),
      title: ['Exactly what I needed', 'Great print quality', 'Fast delivery', 'Worth the price', 'Latest edition confirmed', 'Solid buy'][i],
      comment: 'Arrived quickly, well packed, and the edition matched the listing exactly. Would order again.',
      isApproved: true,
      isVerifiedPurchase: true,
    })),
  );
  await Promise.all(created.slice(0, 6).map((p) => Review.recalculate(p._id)));

  logger.info('Seed complete.');
  logger.info('──────────────────────────────────────────────');
  logger.info(`Admin login  : ${username} / ${process.env.ADMIN_PASSWORD || 'admin'}`);
  logger.info(`Images served: ${BACKEND}/uploads/products/…`);
  logger.info(`Storefront   : ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
  logger.info(`Admin panel  : ${process.env.ADMIN_URL || 'http://localhost:5174'}`);
  logger.info('──────────────────────────────────────────────');
}

(async () => {
  await connectDB();
  try {
    if (process.argv.includes('--destroy')) await destroy();
    else await seed();
    await mongoose.connection.close();
    process.exit(0);
  } catch (err) {
    logger.error('Seed failed:', err);
    await mongoose.connection.close();
    process.exit(1);
  }
})();
