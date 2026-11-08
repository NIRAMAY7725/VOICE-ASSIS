// ============================================
// tools/toolArgs.js — Zod schemas for AI tool arguments
// ============================================
// WHY THIS FILE?
// The AI's function-calling output is UNTRUSTED input: a prompt-injected
// model reply could emit extra keys like {"userId": "<someone else>"} or
// Mongo operators like {"$set": {...}}. The REST routes are already guarded
// by Zod, but the tool path in mainAgent.js used to pass raw model JSON
// straight into taskService (and therefore into findOneAndUpdate).
//
// These schemas validate + STRIP unknown keys (Zod's default behaviour)
// before any executor runs, so only the documented fields ever reach the
// database layer. taskId is constrained to a 24-hex ObjectId, and filter
// values are typed enums/strings so they can never become query operators.
// ============================================

const { z } = require('zod');

const objectId = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/, 'taskId must be a valid 24-character id.');

const priority = z.enum(['low', 'medium', 'high']);
const status = z.enum(['pending', 'in-progress', 'completed']);
const tags = z.array(z.string().max(50)).max(20);

const toolArgSchemas = {
  createTask: z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    priority: priority.optional(),
    dueDate: z.string().datetime().optional().nullable(),
    tags: tags.optional(),
  }),

  getTasks: z.object({
    status: status.optional(),
    priority: priority.optional(),
    search: z.string().max(200).optional(),
  }),

  updateTask: z.object({
    taskId: objectId,
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional(),
    status: status.optional(),
    priority: priority.optional(),
    dueDate: z.string().datetime().optional().nullable(),
    reminder: z.string().datetime().optional().nullable(),
    tags: tags.optional(),
  }),

  deleteTask: z.object({
    taskId: objectId,
  }),

  createReminder: z.object({
    title: z.string().min(1).max(200),
    reminderDate: z.string().datetime(),
    description: z.string().max(1000).optional(),
  }),

  saveMemory: z.object({
    content: z.string().min(1).max(5000),
    metadata: z.record(z.string(), z.any()).optional(),
  }),
};

module.exports = { toolArgSchemas };