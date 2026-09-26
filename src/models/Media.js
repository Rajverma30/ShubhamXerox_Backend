const mongoose = require('mongoose');
const { MEDIA_FOLDERS } = require('../config/constants');

/** Central media library so the admin can reuse uploaded assets anywhere. */
const mediaSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    cardUrl: String,
    thumbUrl: String,
    publicId: String,
    filename: String,
    originalName: String,
    mimeType: String,
    sizeBytes: Number,
    width: Number,
    height: Number,
    folder: { type: String, enum: MEDIA_FOLDERS, default: 'misc', index: true },
    alt: { type: String, default: '' },
    tags: [String],
    usedIn: [{ model: String, refId: mongoose.Schema.Types.ObjectId, _id: false }],
  },
  { timestamps: true },
);

module.exports = mongoose.model('Media', mediaSchema);
