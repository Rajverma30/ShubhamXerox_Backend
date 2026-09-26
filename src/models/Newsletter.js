const mongoose = require('mongoose');

const newsletterSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: String,
    isSubscribed: { type: Boolean, default: true, index: true },
    source: { type: String, default: 'footer' },
    unsubscribedAt: Date,
  },
  { timestamps: true },
);

module.exports = mongoose.model('Newsletter', newsletterSchema);
