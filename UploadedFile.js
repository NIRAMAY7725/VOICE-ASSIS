// ============================================
// models/UploadedFile.js — Persisted File Assistant uploads
// ============================================
// WHY THIS FILE?
// The File Assistant used to keep extracted text in a 20-slot in-memory Map
// that vanished on every server restart and was shared across all users.
// This model replaces that Map: each upload is a MongoDB document tied to the
// user who uploaded it, so files survive restarts and are never visible to
// other accounts.
//
// FIELDS:
// - userId:       Owner (every query is scoped to this)
// - originalName: The uploaded file's base name (for display + the AI prompt)
// - size:         Original byte size
// - text:         Extracted plain text the AI analyzes
// - expiresAt:    TTL — MongoDB auto-deletes the document after this time
//
// RETENTION:
// Documents expire 24 hours after upload (set by the route). The TTL index
// below performs the cleanup automatically, so storage never grows without
// bound now that the old 20-file cap is gone. Users can also delete sooner
// via DELETE /api/file-assistant/files/:id.
// ============================================

const mongoose = require('mongoose');

const uploadedFileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Uploaded file must belong to a user'],
      index: true,
    },
    originalName: {
      type: String,
      required: [true, 'Original file name is required'],
    },
    size: {
      type: Number,
      default: 0,
    },
    text: {
      type: String,
      required: [true, 'Extracted text is required'],
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// List a user's files newest-first.
uploadedFileSchema.index({ userId: 1, createdAt: -1 });

// TTL index: MongoDB auto-deletes documents once expiresAt passes.
uploadedFileSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('UploadedFile', uploadedFileSchema);