const mongoose = require('mongoose');
const logger = require('../utils/logger');

/** Connect to MongoDB. Exits the process on first-connect failure. */
module.exports = async function connectDB() {
  mongoose.set('strictQuery', true);
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      autoIndex: process.env.NODE_ENV !== 'production',
      serverSelectionTimeoutMS: 15000,
    });
    logger.info(`MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
    return conn;
  } catch (err) {
    logger.error('MongoDB connection failed', err);
    process.exit(1);
  }
};
