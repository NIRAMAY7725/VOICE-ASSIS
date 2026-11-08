// ============================================
// services/taskService.js — Task Management
// ============================================
// WHY THIS FILE?
// Handles all task CRUD operations. The CRITICAL rule here:
// **VERIFY EVERYTHING** — after creating or updating a task,
// we query MongoDB to confirm the change actually happened
// before telling Maya (and the user) it's done.
//
// This follows your rule #1: "Never report success without checking."
// ============================================

const Task = require('../models/Task');

// -------------------------------------------------
// createTask — Create a new task and VERIFY it exists
// -------------------------------------------------
async function createTask(userId, taskData) {
  // 1. Create the task in MongoDB
  const task = await Task.create({
    userId,
    title: taskData.title,
    description: taskData.description || '',
    priority: taskData.priority || 'medium',
    dueDate: taskData.dueDate || null,
    reminder: taskData.reminder || null,
    tags: taskData.tags || [],
  });

  // 2. VERIFY: Query the database to confirm it was saved
  const verified = await Task.findById(task._id).lean();

  if (!verified) {
    throw new Error(
      'Task creation FAILED verification — the task was not found in the database after saving.'
    );
  }

  console.log(`✅ Task created and verified: "${verified.title}" (${verified._id})`);
  return verified;
}

// -------------------------------------------------
// getTasks — Get tasks for a user with optional filters
// -------------------------------------------------
// Filters: { status, priority, search }
async function getTasks(userId, filters = {}) {
  const query = { userId };

  // Apply optional filters
  if (filters.status) {
    query.status = filters.status;
  }
  if (filters.priority) {
    query.priority = filters.priority;
  }
  if (filters.search) {
    query.title = { $regex: filters.search, $options: 'i' };
  }

  const tasks = await Task.find(query)
    .sort({ createdAt: -1 }) // Newest first
    .lean();

  return tasks;
}

// -------------------------------------------------
// getTaskById — Get a single task (with ownership check)
// -------------------------------------------------
async function getTaskById(taskId, userId) {
  const task = await Task.findOne({ _id: taskId, userId }).lean();

  if (!task) {
    throw new Error('Task not found or access denied.');
  }

  return task;
}

// -------------------------------------------------
// updateTask — Update a task and VERIFY the changes
// -------------------------------------------------
async function updateTask(taskId, userId, updates) {
  // 1. Update in MongoDB
  const task = await Task.findOneAndUpdate(
    { _id: taskId, userId }, // Only update if user owns the task
    updates,
    { new: true, runValidators: true } // Return updated doc, validate
  );

  if (!task) {
    throw new Error('Task not found or access denied.');
  }

  // 2. VERIFY: Read it back from the database
  const verified = await Task.findById(task._id).lean();

  if (!verified) {
    throw new Error('Task update FAILED verification.');
  }

  console.log(`✅ Task updated and verified: "${verified.title}"`);
  return verified;
}

// -------------------------------------------------
// deleteTask — Delete a task and VERIFY it's gone
// -------------------------------------------------
async function deleteTask(taskId, userId) {
  // 1. Delete from MongoDB
  const task = await Task.findOneAndDelete({ _id: taskId, userId });

  if (!task) {
    throw new Error('Task not found or access denied.');
  }

  // 2. VERIFY: Confirm it's actually gone
  const shouldBeNull = await Task.findById(taskId).lean();

  if (shouldBeNull) {
    throw new Error('Task deletion FAILED verification — task still exists!');
  }

  console.log(`✅ Task deleted and verified: "${task.title}"`);
  return { deleted: true, title: task.title };
}

// -------------------------------------------------
// createReminder — Create a task with a reminder date
// -------------------------------------------------
async function createReminder(userId, { title, reminderDate, description = '' }) {
  // A reminder is just a task with a reminder field set
  return createTask(userId, {
    title,
    description,
    reminder: reminderDate,
    tags: ['reminder'],
    priority: 'high', // Reminders are high priority by default
  });
}

module.exports = {
  createTask,
  getTasks,
  getTaskById,
  updateTask,
  deleteTask,
  createReminder,
};

