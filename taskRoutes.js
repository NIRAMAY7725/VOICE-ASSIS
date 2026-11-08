// ============================================
// routes/taskRoutes.js — REST API for Tasks
// ============================================
// WHY THIS FILE?
// Provides direct CRUD endpoints for tasks. While Maya can
// manage tasks via the AI chat (using function calling), the
// frontend dashboard also needs direct access for displaying
// and managing tasks without going through the AI.
//
// All routes are protected by JWT authentication.
//
// ENDPOINTS:
//   GET    /api/tasks       → List all tasks (with filters)
//   POST   /api/tasks       → Create a task
//   GET    /api/tasks/:id   → Get a single task
//   PUT    /api/tasks/:id   → Update a task
//   DELETE /api/tasks/:id   → Delete a task
// ============================================

const express = require('express');
const { z } = require('zod');
const { protect } = require('../middleware/auth');
const taskService = require('../services/taskService');

const router = express.Router();

// All task routes require authentication
router.use(protect);

// ===================== ZOD SCHEMAS =====================

const createTaskSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  description: z.string().max(1000).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  dueDate: z.string().datetime().optional().nullable(),
  reminder: z.string().datetime().optional().nullable(),
  tags: z.array(z.string()).optional(),
});

const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  status: z.enum(['pending', 'in-progress', 'completed']).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  dueDate: z.string().datetime().optional().nullable(),
  reminder: z.string().datetime().optional().nullable(),
  tags: z.array(z.string()).optional(),
});

// ===================== ROUTES =====================

// GET /api/tasks — List tasks with optional filters
router.get('/', async (req, res) => {
  try {
    const filters = {};
    if (req.query.status) filters.status = req.query.status;
    if (req.query.priority) filters.priority = req.query.priority;
    if (req.query.search) filters.search = req.query.search;

    const tasks = await taskService.getTasks(req.user._id.toString(), filters);

    res.json({ success: true, count: tasks.length, tasks });
  } catch (error) {
    console.error('Get tasks error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/tasks — Create a task
router.post('/', async (req, res) => {
  try {
    const data = createTaskSchema.parse(req.body);
    const task = await taskService.createTask(req.user._id.toString(), data);

    res.status(201).json({ success: true, task });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: error.issues.map((e) => e.message).join(', '),
      });
    }
    console.error('Create task error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/tasks/:id — Get a single task
router.get('/:id', async (req, res) => {
  try {
    const task = await taskService.getTaskById(
      req.params.id,
      req.user._id.toString()
    );
    res.json({ success: true, task });
  } catch (error) {
    res.status(404).json({ success: false, error: error.message });
  }
});

// PUT /api/tasks/:id — Update a task
router.put('/:id', async (req, res) => {
  try {
    const data = updateTaskSchema.parse(req.body);
    const task = await taskService.updateTask(
      req.params.id,
      req.user._id.toString(),
      data
    );
    res.json({ success: true, task });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: error.issues.map((e) => e.message).join(', '),
      });
    }
    res.status(400).json({ success: false, error: error.message });
  }
});

// DELETE /api/tasks/:id — Delete a task
router.delete('/:id', async (req, res) => {
  try {
    const result = await taskService.deleteTask(
      req.params.id,
      req.user._id.toString()
    );
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;

