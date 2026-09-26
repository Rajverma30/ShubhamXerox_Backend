const Admin = require('../models/Admin');
const logger = require('../utils/logger');

/**
 * Ensures that the admin account configured via environment variables
 * (ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_EMAIL) exists in MongoDB.
 * Run automatically on server startup.
 */
module.exports = async function ensureAdmin() {
  const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD || 'admin';
  const email = (process.env.ADMIN_EMAIL || 'admin@subhamxerox.com').toLowerCase().trim();

  try {
    let admin = await Admin.findOne({ username }).select('+password');

    if (!admin) {
      admin = await Admin.create({
        username,
        password,
        email,
        name: 'Store Admin',
        role: 'admin',
        isActive: true,
      });
      logger.info(`[boot] Bootstrapped admin account: "${username}"`);
    } else {
      const matches = await admin.comparePassword(password);
      if (!matches) {
        admin.password = password;
        await admin.save();
        logger.info(`[boot] Updated admin password for "${username}" from environment variables`);
      }
      if (!admin.isActive) {
        admin.isActive = true;
        await admin.save({ validateBeforeSave: false });
        logger.info(`[boot] Re-activated admin account: "${username}"`);
      }
    }
  } catch (err) {
    logger.error(`[boot] Failed to ensure admin account: ${err.message}`);
  }
};
