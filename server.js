/**
 * Shubham Xerox — API entry point.
 * Boots the database first, then the HTTP server, and wires graceful shutdown.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const app = require('./src/app');
const connectDB = require('./src/config/db');
const ensureAdmin = require('./src/config/ensureAdmin');
const logger = require('./src/utils/logger');

/**
 * Upload pre-flight check.
 *
 * Image upload has three failure modes that all surface as an unhelpful error
 * in the browser, so check them once at boot and say plainly which one is broken:
 *   1. `sharp` is a native binary — it survives `npm install` on your laptop
 *      but is frequently broken on the server after a deploy or a Node upgrade.
 *   2. the uploads/ folders must exist and be writable by the node user.
 *   3. BACKEND_URL must be absolute, or images save fine and then 404.
 */
function checkUploads() {
  try {
    require('sharp');
    logger.info('sharp: OK');
  } catch (err) {
    logger.error(
      `sharp FAILED to load (${err.message}). Image uploads will 500. ` +
      'Fix with:  npm rebuild sharp --verbose   (or: npm i sharp --include=optional)',
    );
  }

  const root = path.join(__dirname, process.env.UPLOAD_DIR || 'uploads');
  for (const dir of ['tmp', 'products', 'pdf', 'ebooks', 'banners', 'media']) {
    const full = path.join(root, dir);
    try {
      fs.mkdirSync(full, { recursive: true });
      fs.accessSync(full, fs.constants.W_OK);
    } catch {
      logger.error(`uploads/${dir} is not writable by this user. Fix with:  chown -R $(whoami) ${root}`);
    }
  }

  const backendUrl = process.env.BACKEND_URL || '';
  if (!/^https?:\/\//.test(backendUrl)) {
    logger.warn(
      'BACKEND_URL is not set to an absolute URL. Uploaded images will be stored with ' +
      'localhost URLs and will not load on the live storefront. ' +
      'Set BACKEND_URL=https://your-api-domain in .env',
    );
  }

  const maxImage = Number(process.env.MAX_IMAGE_MB) || 8;
  logger.info(
    `Upload limits: images ${maxImage}MB, PDFs ${Number(process.env.MAX_PDF_MB) || 60}MB. ` +
    'Your reverse proxy must allow at least this much (nginx: client_max_body_size).',
  );
}

const PORT = process.env.PORT || 5000;

(async () => {
  await connectDB();
  await ensureAdmin();
  checkUploads();

  const server = app.listen(PORT, () => {
    logger.info(`Shubham Xerox API listening on :${PORT} (${process.env.NODE_ENV || 'development'})`);
  });

  const shutdown = (signal) => () => {
    logger.warn(`${signal} received — closing server`);
    server.close(() => process.exit(0));
    // Force-exit if connections refuse to drain.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    logger.error('Unhandled rejection', err);
    server.close(() => process.exit(1));
  });
})();
