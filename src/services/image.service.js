/**
 * Image post-processing.
 * Every uploaded raster image is normalised to WebP at three sizes
 * (thumb / card / full) so the storefront can serve tiny payloads.
 */
const path = require('path');
const fs = require('fs/promises');
const sharp = require('sharp');
const cloudinary = require('../config/cloudinary');
const { ROOT } = require('../middleware/upload');
const logger = require('../utils/logger');

const SIZES = { thumb: 160, card: 600, full: 1400 };

/**
 * Absolute URL for a stored file.
 *
 * BACKEND_URL must be absolute: the storefront and admin panel run on other
 * origins, so a root-relative "/uploads/…" would resolve against *their* host
 * and 404. Falls back to localhost:PORT for local development.
 *
 * Railway also exposes /img as an alias of /uploads.
 */
const backendOrigin = () =>
  (process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, '');

const assetPrefix = () => (/railway\.app/i.test(backendOrigin()) ? 'img' : 'uploads');

const publicUrl = (folder, filename) => `${backendOrigin()}/${assetPrefix()}/${folder}/${filename}`;

/**
 * Process one temp file into a stored image record.
 * @returns {{url,thumbUrl,cardUrl,width,height,publicId,alt}}
 */
async function processImage(tmpPath, { folder = 'products', alt = '' } = {}) {
  // SVGs are passed through untouched (sharp raster-ises them otherwise).
  if (path.extname(tmpPath).toLowerCase() === '.svg') {
    const filename = path.basename(tmpPath);
    const dest = path.join(ROOT, folder, filename);
    await fs.rename(tmpPath, dest);
    const url = publicUrl(folder, filename);
    return { url, thumbUrl: url, cardUrl: url, width: 0, height: 0, publicId: null, alt };
  }

  const base = path.basename(tmpPath, path.extname(tmpPath));
  const meta = await sharp(tmpPath).metadata();
  const out = {};

  await Promise.all(
    Object.entries(SIZES).map(async ([key, width]) => {
      const filename = `${base}-${key}.webp`;
      const dest = path.join(ROOT, folder, filename);
      await sharp(tmpPath)
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: key === 'thumb' ? 68 : 82 })
        .toFile(dest);
      out[key] = { filename, dest };
    }),
  );

  await fs.unlink(tmpPath).catch(() => {});

  // Optional Cloudinary mirror for the full-size asset.
  if (cloudinary.enabled) {
    try {
      const remote = await cloudinary.upload(out.full.dest, folder);
      if (remote) {
        return {
          url: remote.url,
          thumbUrl: remote.url.replace('/upload/', '/upload/w_160,f_webp,q_auto/'),
          cardUrl: remote.url.replace('/upload/', '/upload/w_600,f_webp,q_auto/'),
          width: remote.width,
          height: remote.height,
          publicId: remote.publicId,
          alt,
        };
      }
    } catch (err) {
      logger.warn('Cloudinary upload failed, keeping local copy:', err.message);
    }
  }

  return {
    url: publicUrl(folder, out.full.filename),
    thumbUrl: publicUrl(folder, out.thumb.filename),
    cardUrl: publicUrl(folder, out.card.filename),
    width: meta.width || 0,
    height: meta.height || 0,
    publicId: null,
    alt,
  };
}

/** Process an array of multer files in parallel. */
async function processMany(files = [], opts = {}) {
  return Promise.all(files.map((f) => processImage(f.path, opts)));
}

/** Store an already-generated buffer (used by the PDF pipeline). */
async function storeBuffer(buffer, { folder = 'products', filename, alt = '' }) {
  const name = `${filename}.webp`;
  const dest = path.join(ROOT, folder, name);
  const img = sharp(buffer).rotate();
  const meta = await img.metadata();

  await Promise.all([
    img.clone().resize({ width: SIZES.full, withoutEnlargement: true }).webp({ quality: 82 }).toFile(dest),
    img.clone().resize({ width: SIZES.card, withoutEnlargement: true }).webp({ quality: 82 })
      .toFile(path.join(ROOT, folder, `${filename}-card.webp`)),
    img.clone().resize({ width: SIZES.thumb, withoutEnlargement: true }).webp({ quality: 68 })
      .toFile(path.join(ROOT, folder, `${filename}-thumb.webp`)),
  ]);

  return {
    url: publicUrl(folder, name),
    cardUrl: publicUrl(folder, `${filename}-card.webp`),
    thumbUrl: publicUrl(folder, `${filename}-thumb.webp`),
    width: meta.width || 0,
    height: meta.height || 0,
    publicId: null,
    alt,
    source: 'pdf',
  };
}

module.exports = { processImage, processMany, storeBuffer, publicUrl, SIZES };
