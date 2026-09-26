/**
 * Money maths. Cart and order totals are calculated by Shiprocket Checkout;
 * this module only derives a product's selling price, which the catalogue and
 * the Shiprocket product feed both read.
 */
const round = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Effective selling price of a product document, in whole rupees.
 *
 * Indian retail prices don't carry paise, and the storefront formats money
 * with `maximumFractionDigits: 0`. If this returned 419.30 the customer would
 * see "₹419" but be charged ₹419.30 — and any external system reading the
 * catalogue (Shiprocket Checkout, for one) would quote the decimal. Rounding
 * to whole rupees here makes displayed price, charged price and synced price
 * identical everywhere.
 */
function sellingPrice(product) {
  if (product.salePrice && product.salePrice > 0) return Math.round(product.salePrice);
  const pct = Number(product.discountPercent) || 0;
  return Math.round(Number(product.price) * (1 - pct / 100));
}

module.exports = { round, sellingPrice };
