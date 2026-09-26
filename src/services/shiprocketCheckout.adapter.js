/**
 * Maps our Mongo documents onto the JSON shape Shiprocket Checkout expects
 * from a custom platform's catalogue endpoints.
 *
 * Output format strictly mirrors Shopify Admin API / Fastrr reference spec:
 *
 * GET /shiprocket-checkout/products
 * GET /shiprocket-checkout/collections
 * GET /shiprocket-checkout/collections/{collection_id}/products
 */
const { sellingPrice } = require('../utils/pricing');

const iso = (d) => (d ? new Date(d).toISOString() : new Date().toISOString());
const publicBaseUrl = () => String(process.env.BACKEND_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '');
const publicUrl = (value) => {
  const url = String(value || '').trim();
  if (!url || /^(https?:)?\/\//i.test(url) || url.startsWith('data:')) return url;
  const base = publicBaseUrl();
  return base ? `${base}/${url.replace(/^\//, '')}` : url;
};

/** Numeric id derived from the Mongo ObjectId — stable, unique integer. */
const numericId = (objectId) => parseInt(String(objectId).slice(-12), 16);

/**
 * One product → exact Shopify-style product object expected by Shiprocket / Fastrr.
 */
function toProduct(p) {
  const price = sellingPrice(p);
  const pId = numericId(p._id);
  const variantId = pId * 10 + 1; // Distinct, stable numeric variant ID

  const imageUrl = p.images?.[0]?.url ? publicUrl(p.images[0].url) : '';
  const weightKg = p.type === 'ebook' ? 0 : Number(p.weight) || 0.3;
  const grams = Math.round(weightKg * 1000);
  const tagsStr = Array.isArray(p.tags) ? p.tags.join(', ') : String(p.tags || '');

  return {
    id: pId,
    title: p.title || '',
    body_html: p.description || p.shortDescription || '',
    vendor: p.publisher || p.brand || 'Shubham Xerox',
    product_type: p.subCategoryName || p.categoryName || p.type || 'Books',
    created_at: iso(p.createdAt),
    handle: p.slug || '',
    updated_at: iso(p.updatedAt),
    tags: tagsStr,
    status: p.isActive && !p.isHidden ? 'active' : 'draft',
    variants: [
      {
        id: variantId,
        title: 'Default Title',
        price: price.toFixed(2),
        sku: p.sku || p.slug || String(p._id),
        created_at: iso(p.createdAt),
        updated_at: iso(p.updatedAt),
        taxable: true,
        grams,
        image: {
          src: imageUrl,
        },
        weight: weightKg,
        weight_unit: 'kg',
      },
    ],
  };
}

/**
 * One Category or SubCategory → Shopify-style collection object expected by Shiprocket.
 */
function toCollection(doc) {
  return {
    id: numericId(doc._id),
    title: doc.name || '',
    handle: doc.slug || '',
    body_html: doc.description || doc.shortDescription || '',
    created_at: iso(doc.createdAt),
    updated_at: iso(doc.updatedAt),
    image: doc.image?.url ? { src: publicUrl(doc.image.url) } : null,
    status: doc.isActive ? 'active' : 'draft',
  };
}

/**
 * Wraps results in top-level { "data": { "total": <number>, [key]: items } } envelope.
 */
function envelope(key, items, { total }) {
  return {
    data: {
      total: Number(total) || items.length,
      [key]: items,
    },
  };
}

module.exports = { toProduct, toCollection, envelope, numericId };

