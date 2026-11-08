// ============================================
// agents/mainAgent.js — The Orchestrator
// ============================================
// WHY THIS FILE?
// This is Maya's "brain". It ties everything together:
//   1. Takes user input (text from voice or chat)
//   2. Loads conversation history (short-term memory)
//   3. Injects long-term memories for context
//   4. Sends everything to OpenAI with tool definitions
//   5. If the AI wants to call a tool → executes it → sends result back
//   6. Returns the final reply to speak/display
//
// TOOL EXECUTION LOOP:
// The AI might call tools multiple times in one turn.
// We loop: AI reply → tool call → execute → send result → AI reply…
// until the AI gives a final text response (no more tool calls).
// ============================================

const aiService = require('../services/aiService');
const { chatCompletion, extractReply, routeModel } = aiService;
const memoryService = require('../services/memoryService');
const taskService = require('../services/taskService');
const { toolDefinitions } = require('../tools/taskTools');
const { toolArgSchemas } = require('../tools/toolArgs');

// -------------------------------------------------
// Tool executor — maps tool names to actual functions
// -------------------------------------------------
// When the AI says "call createTask with {title: 'Study math'}",
// this map tells us which actual function to run.
const toolExecutors = {
  createTask: async (args, userId) => {
    const task = await taskService.createTask(userId, args);
    return { success: true, task };
  },

  getTasks: async (args, userId) => {
    const tasks = await taskService.getTasks(userId, args);
    return { success: true, tasks, count: tasks.length };
  },

  updateTask: async (args, userId) => {
    const { taskId, ...updates } = args;
    const task = await taskService.updateTask(taskId, userId, updates);
    return { success: true, task };
  },

  deleteTask: async (args, userId) => {
    const result = await taskService.deleteTask(args.taskId, userId);
    return { success: true, ...result };
  },

  createReminder: async (args, userId) => {
    const task = await taskService.createReminder(userId, args);
    return { success: true, reminder: task };
  },

  saveMemory: async (args, userId) => {
    const memory = await memoryService.saveLongTermMemory(
      userId,
      args.content,
      args.metadata || {}
    );
    return { success: true, memory };
  },
};

// -------------------------------------------------
// Shared helpers (used by both the classic and streaming paths)
// -------------------------------------------------

// Load history + long-term context in parallel (they're independent),
// then assemble the message array for the model.
async function buildContextMessages(userMessage, userId, sid) {
  const [history, memoryContext] = await Promise.all([
    memoryService.getShortTermMemory(userId, sid),
    memoryService.buildMemoryContext(userId),
  ]);

  const messages = [...history];
  if (memoryContext) {
    messages.push({
      role: 'system',
      content: `Here is what you remember about this user:\n${memoryContext}`,
    });
  }
  messages.push({ role: 'user', content: userMessage });

  // Save user message to short-term memory
  await memoryService.addShortTermMemory(userId, sid, 'user', userMessage);
  return messages;
}

// Execute one batch of tool calls with Zod validation, appending results to
// the conversation and the frontend-facing toolResults array.
async function executeToolCalls(toolCalls, messages, toolResults, userId) {
  for (const toolCall of toolCalls) {
    const functionName = toolCall.function.name;
    let args = {};
    let toolResult;

    try {
      // Parse and validate arguments BEFORE execution.
      // Zod strips unknown keys, so AI-supplied fields like userId
      // or $-operators never reach the database layer.
      args = JSON.parse(toolCall.function.arguments);
      const schema = toolArgSchemas[functionName];
      if (schema) args = schema.parse(args);

      console.log(`  → Executing: ${functionName}(${JSON.stringify(args)})`);

      const executor = toolExecutors[functionName];
      if (!executor) {
        throw new Error(`Unknown tool: ${functionName}`);
      }
      toolResult = await executor(args, userId);
    } catch (error) {
      const message = error.name === 'ZodError'
        ? error.issues.map((issue) => issue.message).join(', ')
        : error.message;
      console.error(`  ❌ Tool error: ${message}`);
      toolResult = { success: false, error: message };
    }

    toolResults.push({ tool: functionName, args, result: toolResult });
    messages.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: JSON.stringify(toolResult),
    });
  }
}

// Per-turn AI options: routed model + voice-mode prompt/token budget.
function turnOptions(userMessage, voiceMode) {
  return {
    model: routeModel(userMessage),
    ...(voiceMode
      ? { systemPrompt: aiService.MAYA_VOICE_SYSTEM_PROMPT, maxTokens: aiService.VOICE_MAX_TOKENS }
      : {}),
  };
}

const MAX_TOOL_LOOPS = 5; // Safety: prevent infinite loops
const FALLBACK_REPLY = "I'm not sure how to respond to that. 😊";

// -------------------------------------------------
// processMessage — Main entry point (classic, non-streaming)
// -------------------------------------------------
// This is what routes call. It handles the full cycle:
// input → memories → AI → tools → AI → reply
//
// Parameters:
//   userMessage: string (what the user said)
//   userId:      string (MongoDB user ID)
//   sessionId:   string (for short-term memory, defaults to
//                        a combination of the user ID)
//   options:     { voiceMode } — shorter spoken-style replies
// -------------------------------------------------
async function processMessage(userMessage, userId, sessionId = null, options = {}) {
  const sid = sessionId || `session-${userId}`;
  const messages = await buildContextMessages(userMessage, userId, sid);
  const aiOptions = turnOptions(userMessage, options.voiceMode === true);

  // 4. Call the AI (with tool definitions)
  let response = await chatCompletion(messages, toolDefinitions, aiOptions);
  let result = extractReply(response);
  const toolResults = []; // Track all tool calls for the frontend

  // 5. Tool execution loop
  // The AI might call one or more tools. We execute each one,
  // send the results back, and let the AI continue.
  let loops = 0;

  while (result.toolCalls && loops < MAX_TOOL_LOOPS) {
    loops++;
    console.log(`🔧 Tool loop ${loops}: ${result.toolCalls.length} tool(s) to execute`);
    messages.push(result.message);
    await executeToolCalls(result.toolCalls, messages, toolResults, userId);

    // Call the AI again with the tool results
    response = await chatCompletion(messages, toolDefinitions, aiOptions);
    result = extractReply(response);
  }

  // 6. Save assistant's reply to short-term memory
  const replyText = result.content || FALLBACK_REPLY;
  await memoryService.addShortTermMemory(userId, sid, 'assistant', replyText);

  return {
    reply: replyText,
    toolResults,
  };
}

// -------------------------------------------------
// processMessageStream — SSE streaming variant
// -------------------------------------------------
// Same cycle, but content tokens are delivered through onToken as they
// arrive. Tool-call turns are accumulated from stream deltas, executed
// with the same Zod validation, and the follow-up reply is streamed too.
// options: { signal, onToken, voiceMode }
// -------------------------------------------------
async function processMessageStream(userMessage, userId, sessionId = null, options = {}) {
  const { signal = null, onToken = null, voiceMode = false } = options;
  const sid = sessionId || `session-${userId}`;
  const messages = await buildContextMessages(userMessage, userId, sid);
  const aiOptions = turnOptions(userMessage, voiceMode === true);
  const toolResults = [];
  let replyText = '';

  for (let loops = 0; loops <= MAX_TOOL_LOOPS; loops++) {
    let content = '';
    // Tool calls arrive as fragmented deltas keyed by index.
    const toolCallDeltas = new Map();

    // Namespace call (not destructured) so tests can stub the stream.
    const stream = aiService.streamChatCompletion(messages, toolDefinitions, aiOptions, signal);
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        if (onToken) onToken(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallDeltas.get(tc.index) || {
            id: '',
            type: 'function',
            function: { name: '', arguments: '' },
          };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.function.name += tc.function.name;
          if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
          toolCallDeltas.set(tc.index, existing);
        }
      }
    }

    const toolCalls = [...toolCallDeltas.values()].filter((tc) => tc.id && tc.function.name);

    // No tool calls → this was the final answer (already streamed).
    if (toolCalls.length === 0 || loops === MAX_TOOL_LOOPS) {
      replyText = content;
      break;
    }

    console.log(`🔧 Tool loop ${loops + 1}: ${toolCalls.length} tool(s) to execute`);
    messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
    await executeToolCalls(toolCalls, messages, toolResults, userId);
  }

  replyText = replyText || FALLBACK_REPLY;
  await memoryService.addShortTermMemory(userId, sid, 'assistant', replyText);

  return {
    reply: replyText,
    toolResults,
  };
}

module.exports = {
  processMessage,
  processMessageStream,
};

