// ============================================
// services/memoryService.js — Memory Management
// ============================================
// WHY THIS FILE?
// Maya has 4 types of memory. This service provides clean
// CRUD operations for each type, keeping the rest of the
// codebase simple.
//
// MEMORY TYPES (recap):
// 1. short-term  → conversation history (per session, persisted in MongoDB)
// 2. long-term   → persistent user preferences/facts (MongoDB)
// 3. task        → task-related (handled by taskService mostly)
// 4. knowledge   → study notes, explanations (MongoDB)
//
// SHORT-TERM MEMORY:
// One MongoDB document per (userId, sessionId) with type 'short-term'.
// A rolling window of the last N messages lives in metadata.messages
// (N = MEMORY_WINDOW_MESSAGES, default 6). Reads also apply a rough token
// cap (MEMORY_TOKEN_CAP, default 1500), dropping oldest messages first.
// Each write refreshes expiresAt; the model's TTL index auto-deletes idle
// sessions, so history survives a server restart but never grows forever.
// ============================================

const Memory = require('../models/Memory');

// ===================== SHORT-TERM =====================

// A session expires after this much inactivity. Every new message refreshes it.
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Sliding window sent to the model: last N messages (default 6 = 3 exchanges),
// then a rough token cap on top. Both are env-configurable. The system prompt
// is prepended by aiService and is NEVER part of this history, so it is always
// kept regardless of trimming.
const MAX_MESSAGES = Math.max(2, parseInt(process.env.MEMORY_WINDOW_MESSAGES, 10) || 6);
const HISTORY_TOKEN_CAP = Math.max(200, parseInt(process.env.MEMORY_TOKEN_CAP, 10) || 1500);

// Rough token estimate (~4 chars/token). Good enough for a budget cap —
// exact tokenization would cost a dependency and CPU on every turn.
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

// Keep the newest messages within the token cap; drop oldest first.
// The newest message is always kept (a conversation needs its latest turn).
function trimToWindow(messages, maxMessages = MAX_MESSAGES, tokenCap = HISTORY_TOKEN_CAP) {
  const windowed = (Array.isArray(messages) ? messages : []).slice(-maxMessages);
  const kept = [];
  let used = 0;
  for (let i = windowed.length - 1; i >= 0; i--) {
    const cost = estimateTokens(windowed[i].content) + 4; // per-message overhead
    if (used + cost > tokenCap && kept.length > 0) break;
    kept.unshift(windowed[i]);
    used += cost;
  }
  return kept;
}

// Query filter for the single document that holds a session's history.
function sessionFilter(userId, sessionId) {
  return { userId, type: 'short-term', 'metadata.sessionId': sessionId };
}

/**
 * Get the conversation history for a session.
 * Returns an array of { role, content } messages (oldest → newest),
 * trimmed to the sliding window + token cap before it reaches the model.
 */
async function getShortTermMemory(userId, sessionId) {
  const doc = await Memory.findOne(sessionFilter(userId, sessionId)).lean();
  const messages = Array.isArray(doc?.metadata?.messages) ? doc.metadata.messages : [];
  return trimToWindow(messages);
}

/**
 * Add a message to the session's conversation history.
 * Atomically appends and keeps only the last N messages, and refreshes the
 * session TTL so active conversations stay alive while idle ones expire.
 */
async function addShortTermMemory(userId, sessionId, role, content) {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await Memory.findOneAndUpdate(
    sessionFilter(userId, sessionId),
    {
      // $push + $each + $slice keeps the rolling window in a single atomic write.
      $push: {
        'metadata.messages': { $each: [{ role, content }], $slice: -MAX_MESSAGES },
      },
      $set: {
        content: 'Short-term session memory',
        'metadata.sessionId': sessionId,
        expiresAt,
      },
    },
    { upsert: true, setDefaultsOnInsert: true }
  );
}

/**
 * Clear a session's short-term memory (e.g., user says "forget this conversation").
 */
async function clearShortTermMemory(userId, sessionId) {
  await Memory.deleteOne(sessionFilter(userId, sessionId));
}

// ===================== LONG-TERM =====================

/**
 * Save a long-term memory (user preference or fact).
 * Example: "User is allergic to peanuts"
 */
async function saveLongTermMemory(userId, content, metadata = {}) {
  const memory = await Memory.create({
    userId,
    type: 'long-term',
    content,
    metadata,
  });
  return memory;
}

/**
 * Retrieve all long-term memories for a user.
 * Sorted newest-first so the most recent preferences take priority.
 */
async function getLongTermMemories(userId, limit = 50) {
  return Memory.find({ userId, type: 'long-term' })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean(); // .lean() returns plain objects (faster, less memory)
}

/**
 * Search long-term memories by keyword.
 * Uses MongoDB text search on the content field.
 */
async function searchLongTermMemories(userId, query) {
  return Memory.find({
    userId,
    type: 'long-term',
    content: { $regex: query, $options: 'i' }, // Case-insensitive search
  })
    .sort({ createdAt: -1 })
    .lean();
}

/**
 * Delete a specific long-term memory by ID.
 */
async function deleteLongTermMemory(memoryId, userId) {
  return Memory.findOneAndDelete({ _id: memoryId, userId });
}

// ===================== KNOWLEDGE BASE =====================

/**
 * Save a knowledge memory (study notes, explanations).
 * Metadata can include: { topic, subject, source }
 */
async function saveKnowledge(userId, content, metadata = {}) {
  const memory = await Memory.create({
    userId,
    type: 'knowledge',
    content,
    metadata,
  });
  return memory;
}

/**
 * Get all knowledge entries for a user, optionally filtered by topic.
 */
async function getKnowledge(userId, topic = null, limit = 50) {
  const filter = { userId, type: 'knowledge' };
  if (topic) {
    filter['metadata.topic'] = { $regex: topic, $options: 'i' };
  }
  return Memory.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
}

// ===================== CONTEXT BUILDER =====================

/**
 * Build a context string from the user's memories to inject
 * into the AI prompt. This gives Maya "memory" of the user.
 *
 * Returns a formatted string like:
 * "USER MEMORIES:\n- Prefers dark mode\n- Studies computer science\n..."
 */
async function buildMemoryContext(userId) {
  const longTermMems = await getLongTermMemories(userId, 10);
  const knowledgeMems = await getKnowledge(userId, null, 5);

  const parts = [];

  if (longTermMems.length > 0) {
    parts.push('WHAT I KNOW ABOUT YOU:');
    longTermMems.forEach((m) => parts.push(`- ${m.content}`));
  }

  if (knowledgeMems.length > 0) {
    parts.push('\nSAVED KNOWLEDGE:');
    knowledgeMems.forEach((m) => {
      const topic = m.metadata?.topic ? `[${m.metadata.topic}] ` : '';
      parts.push(`- ${topic}${m.content}`);
    });
  }

  return parts.length > 0 ? parts.join('\n') : '';
}

module.exports = {
  // Short-term
  getShortTermMemory,
  addShortTermMemory,
  clearShortTermMemory,
  estimateTokens,
  trimToWindow,
  // Long-term
  saveLongTermMemory,
  getLongTermMemories,
  searchLongTermMemories,
  deleteLongTermMemory,
  // Knowledge
  saveKnowledge,
  getKnowledge,
  // Context
  buildMemoryContext,
};

