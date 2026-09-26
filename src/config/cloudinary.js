/**
 * Optional Cloudinary bridge.
 * When USE_CLOUDINARY=false (default) every helper resolves to `null`
 * and callers fall back to the local /uploads folder — so the project
 * runs with zero third-party accounts.
 */
const fs = require('fs');
const logger = require('../utils/logger');

const enabled = String(process.env.USE_CLOUDINARY).toLowerCase() === 'true';
let cloudinary = null;

if (enabled) {
  try {
    cloudinary = require('cloudinary').v2;
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_NAME,
      api_key: process.env.CLOUDINARY_KEY,
      api_secret: process.env.CLOUDINARY_SECRET,
      secure: true,
    });
    logger.info('Cloudinary enabled');
  } catch (err) {
    logger.warn('USE_CLOUDINARY=true but the cloudinary package is missing — using local storage.');
    cloudinary = null;
  }
}

/** Upload a local file and remove the temp copy. Returns null when disabled. */
async function upload(localPath, folder = 'misc') {
  if (!cloudinary) return null;
  const res = await cloudinary.uploader.upload(localPath, {
    folder: `subham-xerox/${folder}`,
    resource_type: 'auto',
  });
  fs.promises.unlink(localPath).catch(() => {});
  return { url: res.secure_url, publicId: res.public_id, width: res.width, height: res.height };
}

async function destroy(publicId) {
  if (!cloudinary || !publicId) return null;
  return cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
}

module.exports = { enabled: Boolean(cloudinary), upload, destroy };
