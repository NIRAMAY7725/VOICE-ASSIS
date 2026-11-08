// ============================================
// models/Task.js — Task Schema
// ============================================
// WHY THIS FILE?
// Maya can create, track, and manage tasks for the user.
// This schema defines the shape of every task in MongoDB.
//
// FIELDS:
// - userId:      Links this task to the user who owns it
// - title:       Short description ("Finish math homework")
// - description: Optional longer details
// - status:      pending → in-progress → completed
// - priority:    low / medium / high
// - dueDate:     Optional deadline
// - reminder:    Optional reminder time (for createReminder tool)
// - tags:        Optional labels for organization
//
// INDEXES:
// We index by userId + status so Maya can quickly find
// "all pending tasks for user X".
// ============================================

const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Task must belong to a user'],
      index: true,
    },
    title: {
      type: String,
      required: [true, 'Task title is required'],
      trim: true,
      maxlength: [200, 'Title cannot exceed 200 characters'],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [1000, 'Description cannot exceed 1000 characters'],
      default: '',
    },
    status: {
      type: String,
      enum: ['pending', 'in-progress', 'completed'],
      default: 'pending',
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium',
    },
    dueDate: {
      type: Date,
      default: null,
    },
    reminder: {
      type: Date,
      default: null,
    },
    tags: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

// Compound index: quickly find tasks by user + status
taskSchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model('Task', taskSchema);

