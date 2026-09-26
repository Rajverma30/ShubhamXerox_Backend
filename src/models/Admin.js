const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

/**
 * Single-admin auth. There is no self-registration route; the account is
 * bootstrapped by `npm run seed` and the credentials live in the database,
 * so they can be changed later from the admin panel.
 */
const adminSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true, minlength: 3 },
    email: { type: String, lowercase: true, trim: true },
    name: { type: String, default: 'Store Admin', trim: true },
    password: { type: String, required: true, select: false, minlength: 4 },
    avatar: String,
    phone: String,
    role: { type: String, enum: ['admin', 'manager'], default: 'admin' },
    isActive: { type: Boolean, default: true },
    lastLoginAt: Date,
    lastLoginIp: String,
    passwordChangedAt: { type: Date, select: false },
  },
  { timestamps: true },
);

adminSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  if (!this.isNew) this.passwordChangedAt = new Date(Date.now() - 1000);
  return next();
});

adminSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model('Admin', adminSchema);
