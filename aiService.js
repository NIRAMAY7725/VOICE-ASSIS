// ============================================
// services/aiService.js — AI Provider Wrapper (Gemini & OpenAI)
// ============================================
// WHY THIS FILE?
// Wraps AI API calls in one place. Supports Google Gemini
// (default) and OpenAI seamlessly.
//
// HOW IT WORKS:
// Google Gemini provides an OpenAI-compatible REST API endpoint:
//   https://generativelanguage.googleapis.com/v1beta/openai/
// This means we can use the battle-tested client library with
// Gemini models (like gemini-3.5-flash) and native tool calling!
//
// SECURITY: The API key is loaded from .env via process.env.
// It NEVER leaves the backend.
// ============================================

const OpenAI = require('openai');

// Bound every AI call: the SDK default is a 10-minute timeout with 2 retries,
// which (across 3 fallback models × several tool-loop turns) can hang a single
// chat for many minutes and hold sockets + rate-limiter slots. Fail fast instead.
const AI_TIMEOUT_MS = 30_000;
const AI_MAX_RETRIES = 1;

let _aiClient = null;
let _currentProvider = null;

function getAIClient() {
  if (_aiClient) return _aiClient;

  const provider = (process.env.AI_PROVIDER || '').toLowerCase();
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (geminiKey || provider === 'gemini') {
    if (!geminiKey) {
      throw new Error('GEMINI_API_KEY is not set in .env');
    }
    _currentProvider = 'gemini';
    _aiClient = new OpenAI({
      apiKey: geminiKey,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      timeout: AI_TIMEOUT_MS,
      maxRetries: AI_MAX_RETRIES,
    });
    console.log(`🤖 AI Service configured: Google Gemini (${process.env.AI_MODEL || 'gemini-3-flash-preview'})`);
    return _aiClient;
  }

  if (openaiKey) {
    _currentProvider = 'openai';
    _aiClient = new OpenAI({
      apiKey: openaiKey,
      timeout: AI_TIMEOUT_MS,
      maxRetries: AI_MAX_RETRIES,
    });
    console.log('🤖 AI Service configured: OpenAI');
    return _aiClient;
  }

  throw new Error(
    'No AI API key found! Please set GEMINI_API_KEY or OPENAI_API_KEY in backend/.env'
  );
}

// -------------------------------------------------
// Model routing — FAST_MODEL for routine turns, HEAVY_MODEL only when
// the request genuinely needs it. Model names live in env vars; the
// per-provider defaults below are the only hardcoded fallbacks.
// -------------------------------------------------
const PROVIDER_DEFAULT_MODELS = {
  gemini: { fast: 'gemini-3.1-flash-lite', heavy: 'gemini-3-flash-preview' },
  openai: { fast: 'gpt-4o-mini', heavy: 'gpt-4o' },
};

function getModelConfig() {
  getAIClient(); // ensures _currentProvider is resolved
  const defaults = PROVIDER_DEFAULT_MODELS[_currentProvider] || PROVIDER_DEFAULT_MODELS.gemini;
  return {
    // FAST_MODEL wins; AI_MODEL is the legacy single-model setting.
    fast: process.env.FAST_MODEL || process.env.AI_MODEL || defaults.fast,
    heavy: process.env.HEAVY_MODEL || defaults.heavy,
  };
}

// Small deterministic router — no extra LLM call (that would add latency).
// Heavy only for: explicit "detailed"-style asks, long-form story writing,
// or complex study explanations. Everything else stays on the fast model.
function routeModel(message) {
  const { fast, heavy } = getModelConfig();
  const text = String(message || '');
  const wantsDetail = /\b(detailed|in[- ]depth|in detail|comprehensive|thorough|elaborate)\b/i.test(text);
  const storyWriting =
    /\b(story|novel|chapter|scene|fiction|fanfic|poem|script)\b/i.test(text) &&
    /\b(write|create|generate|continue|draft|compose|long)\b/i.test(text);
  const complexExplanation =
    /\b(explain|derive|prove|analy[sz]e|compare|evaluate|mechanism)\b/i.test(text) &&
    text.length > 160;
  return wantsDetail || storyWriting || complexExplanation ? heavy : fast;
}

// Voice replies are read aloud: keep them short and conversational, and cap
// tokens lower than text chat (still leaves room for multi-tool turns).
const VOICE_MAX_TOKENS = Math.max(128, parseInt(process.env.VOICE_MAX_TOKENS, 10) || 512);

const MAYA_VOICE_SYSTEM_PROMPT = `You are Maya ❣️, the user's warm, caring best friend, speaking aloud.
Reply in 1–3 short, natural sentences — like talking, not writing. No markdown, no lists, no emoji.
Use tools (createTask, getTasks, createReminder, saveMemory) for actions; confirm only after the tool succeeds. Issue multiple tool calls together when needed.
Be honest, and ask a quick question if the request is unclear.`;

// -------------------------------------------------
// Maya's personality — this is the "system prompt"
// sent at the start of every conversation.
// -------------------------------------------------
const MAYA_SYSTEM_PROMPT = `You are Maya ❣️, the user's loving, supportive best friend and personal AI assistant.

PERSONALITY:
- Warm, caring, cheerful, and encouraging, like a close friend.
- Use a friendly tone and an occasional emoji (❣️ 😊), not too many.
- Celebrate small wins and gently motivate when the user feels low.

YOU HELP WITH:
- Studying: explain topics simply with examples, make notes, quizzes, and study plans.
- Creating stories: brainstorm ideas, build characters, write scenes, and give gentle feedback.
- Daily life: tasks, reminders, and schedules.

RULES:
- Explain step by step in simple language. Ask a quick question if the request is unclear.
- Be honest. If you don't know something, say so.
- Use tools (createTask, getTasks, createReminder, saveMemory) for actions. Only say a task is done AFTER the tool confirms success.
- When one request needs several actions, issue all of those tool calls together in a single response instead of one per turn. Never merge separate items into one call.
- Ask before changing anything important.
- Keep spoken replies short and natural, because they are read aloud.
- Only remember what the user has allowed you to remember.`;

// -------------------------------------------------
// chatCompletion — Send messages to AI and get a reply
// -------------------------------------------------
async function chatCompletion(messages, tools = null, options = {}) {
  const client = getAIClient();
  const defaultModel = getModelConfig().fast;

  const {
    model = defaultModel,
    temperature = 0.7,
    maxTokens = 1024,
    systemPrompt = MAYA_SYSTEM_PROMPT,
  } = options;

  // Build the request payload
  const requestPayload = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
  };

  // Include tools if available
  if (tools && tools.length > 0) {
    requestPayload.tools = tools;
    requestPayload.tool_choice = 'auto';
  }

  const requestedModel = model || defaultModel;
  // Fallbacks come from the same env-driven config — no scattered model names.
  // (Retired models like gemini-2.5-flash are deliberately never listed.)
  const config = getModelConfig();
  const fallbackModels = [...new Set([requestedModel, config.fast, config.heavy])];

  let lastError = null;

  for (const targetModel of fallbackModels) {
    requestPayload.model = targetModel;
    try {
      const response = await client.chat.completions.create(requestPayload);
      return response;
    } catch (error) {
      lastError = error;
      console.warn(`Model ${targetModel} issue (${error.message?.slice(0, 60)}), trying fallback...`);
    }
  }

  console.error('❌ All AI models failed:', lastError?.message);
  throw new Error(`AI Service error: ${lastError?.message}`);
}

// -------------------------------------------------
// streamChatCompletion — SSE-friendly streaming variant
// -------------------------------------------------
// Yields raw OpenAI-compatible chunks (choices[0].delta). Accepts an
// AbortSignal: when the client disconnects, the route aborts and the
// upstream request is cancelled so we don't keep paying for tokens.
// Model fallback only applies BEFORE the stream starts — once tokens
// flow, a mid-stream switch would duplicate output.
async function* streamChatCompletion(messages, tools = null, options = {}, signal = null) {
  const client = getAIClient();
  const config = getModelConfig();
  const {
    model = config.fast,
    temperature = 0.7,
    maxTokens = 1024,
    systemPrompt = MAYA_SYSTEM_PROMPT,
  } = options;

  const requestPayload = {
    model,
    temperature,
    max_tokens: maxTokens,
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
  };
  if (tools && tools.length > 0) {
    requestPayload.tools = tools;
    requestPayload.tool_choice = 'auto';
  }

  const candidates = [...new Set([model, config.fast, config.heavy])];
  let stream = null;
  let lastError = null;

  for (const targetModel of candidates) {
    requestPayload.model = targetModel;
    try {
      stream = await client.chat.completions.create(requestPayload, { signal });
      break;
    } catch (error) {
      // Never "fall back" from a deliberate cancellation.
      if (signal?.aborted) throw error;
      lastError = error;
      console.warn(`Model ${targetModel} stream issue (${error.message?.slice(0, 60)}), trying fallback...`);
    }
  }

  if (!stream) {
    console.error('❌ All AI models failed:', lastError?.message);
    throw new Error(`AI Service error: ${lastError?.message}`);
  }

  for await (const chunk of stream) {
    yield chunk;
  }
}

// -------------------------------------------------
// extractReply — Pull the text reply and tool calls
// -------------------------------------------------
function extractReply(response) {
  const choice = response.choices[0];
  return {
    content: choice.message.content,
    toolCalls: choice.message.tool_calls,
    finishReason: choice.finish_reason,
    message: choice.message,
  };
}

module.exports = {
  chatCompletion,
  streamChatCompletion,
  extractReply,
  routeModel,
  getModelConfig,
  MAYA_SYSTEM_PROMPT,
  MAYA_VOICE_SYSTEM_PROMPT,
  VOICE_MAX_TOKENS,
  AI_TIMEOUT_MS,
  AI_MAX_RETRIES,
};
