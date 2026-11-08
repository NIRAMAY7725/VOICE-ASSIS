// ============================================
// models/User.js — User Schema
// ============================================
// WHY THIS FILE?
// Defines what a "user" looks like in our database.
// Every Maya user gets an account with a hashed password.
//
// FIELDS:
// - name:      Display name (e.g., "Niramay")
// - email:     Unique login identifier
// - password:  Hashed with bcryptjs (NEVER stored as plain text)
// - createdAt: Auto-set by Mongoose timestamps
//
// SECURITY:
// The pre-save hook automatically hashes the password
// before it hits the database. The comparePassword method
// lets us verify login attempts without ever un-hashing.
// ============================================

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [6, 'Password must be at least 6 characters'],
      select: false, // Don't include password in queries by default
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically
  }
);

// --- Pre-save hook: hash password before saving ---
// This runs every time a user is created or their password changes.
// bcrypt "salt rounds" = 10 → good balance of security vs speed.
userSchema.pre('save', async function () {
  // Only hash if the password field was modified
  if (!this.isModified('password')) return;

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// --- Instance method: compare a candidate password to the hash ---
// Usage: const isMatch = await user.comparePassword('guess123');
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);

