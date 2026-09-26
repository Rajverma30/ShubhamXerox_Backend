/**
 * Pushes catalogue changes to Fastrr / Shiprocket's custom-platform webhooks.
 * Pull endpoints remain the source of truth; these POSTs make additions and
 * edits appear in the provider dashboard immediately instead of waiting for a
 * scheduled catalogue pull.
 */
const crypto = require('crypto');
const axios = require('axios');
const { Category, SubCategory } = require('../models');
const logger = require('../utils/logger');
const { toProduct, toCollection } = require('./shiprocketCheckout.adapter');

const enabled = () => String(process.env.SHIPROCKET_AUTO_SYNC || 'true').toLowerCase() !== 'false';
const apiKey = () => process.env.FASTRR_API_KEY || process.env.SHIPROCKET_CHECKOUT_API_KEY || process.env.SHIPROCKET_API_KEY || '';
const secret = () => process.env.FASTRR_WEBHOOK_SECRET || process.env.SHIPROCKET_WEBHOOK_SECRET
  || process.env.SHIPROCKET_CHECKOUT_API_SECRET || process.env.SHIPROCKET_API_SECRET || '';
const productUrl = () => process.env.FASTRR_PRODUCT_WEBHOOK_URL || 'https://checkout-api.shiprocket.com/wh/v1/custom/product';
const collectionUrl = () => process.env.FASTRR_COLLECTION_WEBHOOK_URL || 'https://checkout-api.shiprocket.com/wh/v1/custom/collection';

function configured() {
  return enabled() && Boolean(apiKey() && secret() && productUrl() && collectionUrl());
}

function signature(body) {
  return crypto.createHmac('sha256', secret()).update(body, 'utf8').digest('base64');
}

async function post(url, payload, entity) {
  if (!configured() || !url) return false;
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey(),
    'X-Api-HMAC-SHA256': signature(body),
  };

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await axios.post(url, body, { headers, timeout: 10000 });
      logger.info(`Shiprocket catalogue push succeeded: ${entity} ${payload.id}`);
      return true;
    } catch (err) {
      lastError = err.response?.data?.message || err.response?.status || err.message;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * (2 ** (attempt - 1))));
    }
  }
  logger.warn(`Shiprocket catalogue push failed: ${entity} ${payload.id} (${String(lastError).slice(0, 240)})`);
  return false;
}

async function syncCollectionsForProduct(product, additionalCollectionIds = []) {
  if (!configured()) return;
  const ids = [product.category, product.subCategory, ...additionalCollectionIds].filter(Boolean).map(String);
  if (!ids.length) return;

  const [categories, subCategories] = await Promise.all([
    Category.find({ _id: { $in: ids } }).lean(),
    SubCategory.find({ _id: { $in: ids } }).lean(),
  ]);
  await Promise.all([
    ...categories.map((doc) => post(collectionUrl(), toCollection(doc), 'collection')),
    ...subCategories.map((doc) => post(collectionUrl(), toCollection(doc, { isSubCategory: true }), 'collection')),
  ]);
}

async function syncProduct(product, { status, additionalCollectionIds = [] } = {}) {
  if (!configured() || !product) return false;
  const payload = { ...toProduct(product), status: status || (product.isActive && !product.isHidden ? 'active' : 'draft') };
  const synced = await post(productUrl(), payload, 'product');
  await syncCollectionsForProduct(product, additionalCollectionIds);
  return synced;
}

async function syncCollection(doc, { isSubCategory = false, status } = {}) {
  if (!configured() || !doc) return false;
  return post(collectionUrl(), { ...toCollection(doc, { isSubCategory }), ...(status ? { status } : {}) }, 'collection');
}

/** Fire-and-forget by design: an unavailable provider must never block admin edits. */
function scheduleProductSync(product, options) {
  syncProduct(product?.toObject?.() || product, options).catch((err) => logger.warn(`Shiprocket product sync error: ${err.message}`));
}

function scheduleCollectionSync(collection, options) {
  syncCollection(collection?.toObject?.() || collection, options).catch((err) => logger.warn(`Shiprocket collection sync error: ${err.message}`));
}

function diagnostics() {
  return {
    autoSyncEnabled: enabled(),
    configured: configured(),
    apiKeyConfigured: Boolean(apiKey()),
    webhookSecretConfigured: Boolean(secret()),
    productWebhookConfigured: Boolean(productUrl()),
    collectionWebhookConfigured: Boolean(collectionUrl()),
  };
}

module.exports = {
  configured,
  diagnostics,
  scheduleProductSync,
  scheduleCollectionSync,
  syncProduct,
  syncCollection,
};
