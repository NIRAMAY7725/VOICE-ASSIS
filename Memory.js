// ============================================
// models/Memory.js — Memory Schema
// ============================================
// WHY THIS FILE?
// Maya has 4 types of memory. This single schema handles
// all of them using a "type" field to distinguish:
//
// MEMORY TYPES:
// 1. "short-term"  → current conversation (usually in-memory,
//                     but we can persist for crash recovery)
// 2. "long-term"   → user preferences, facts ("I'm allergic to nuts")
// 3. "task"        → task-related memory (linked via Task model)
// 4. "knowledge"   → study notes, saved explanations
//
// FIELDS:
// - userId:    Who this memory belongs to
// - type:      One of the 4 types above
// - content:   The actual memory text
// - metadata:  Flexible JSON for extra data (topic, source, etc.)
// - expiresAt: Optional TTL (short-term memories can auto-expire)
//
// DESIGN CHOICE:
// Using one collection with a "type" discriminator keeps things
// simple. If memory grows huge, we can split into separate
// collections later — but for a student project, this is perfect.
// ============================================

const mongoose = require('mongoose');

const memorySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Memory must belong to a user'],
      index: true,
    },
    type: {
      type: String,
      enum: ['short-term', 'long-term', 'task', 'knowledge'],
      required: [true, 'Memory type is required'],
    },
    content: {
      type: String,
      required: [true, 'Memory content is required'],
      maxlength: [5000, 'Memory content cannot exceed 5000 characters'],
    },
    metadata: {
      // Flexible field for extra info:
      // { topic: "math", source: "conversation", importance: "high" }
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    expiresAt: {
      // Optional: set a TTL for short-term memories
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Index for quick lookups: "all long-term memories for user X"
memorySchema.index({ userId: 1, type: 1 });

// Fast lookup of a single short-term session document (one per user + session).
memorySchema.index({ userId: 1, type: 1, 'metadata.sessionId': 1 });

// Optional TTL index: MongoDB will auto-delete docs when expiresAt passes
// (only affects documents that actually have an expiresAt value)
memorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Memory', memorySchema);

