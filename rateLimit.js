// ============================================
// middleware/rateLimit.js — AI endpoint throttling
// ============================================
// WHY THIS FILE?
// The AI-generating endpoints (chat, neural TTS, file-assistant ask) are the
// expensive ones: each call hits a paid model or synthesizes audio. A per-IP
// rate limit protects the API budget and keeps one client from starving others.
//
// Limits are intentionally generous for a single human user but block runaway
// scripts. Each limiter returns a JSON body shaped so BOTH frontend readers
// (assistant.js `error` and file-assistant.js `ok`/`error`) surface the message.
// ============================================

const { rateLimit } = require('express-rate-limit');

const MINUTE = 60 * 1000;

function makeLimiter({ limit, windowMs = MINUTE, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true, // Send RateLimit-* headers so clients can back off
    legacyHeaders: false,  // Drop the old X-RateLimit-* headers
    // Identify callers by IP. req.ip is set by Express; no proxy is trusted in dev.
    message: {
      success: false,
      ok: false,
      error: message,
    },
  });
}

// Conversational AI — the primary interaction loop.
const chatLimiter = makeLimiter({
  limit: 30,
  message: 'Too many chat requests. Please wait a moment before sending another message.',
});

// Neural text-to-speech — one audio generation per reply.
const ttsLimiter = makeLimiter({
  limit: 30,
  message: 'Too many speech requests. Please wait a moment before generating more audio.',
});

// File-assistant analysis — heavier: reads documents and runs a model task.
const fileAskLimiter = makeLimiter({
  limit: 20,
  message: 'Too many file-analysis requests. Please wait a moment before running another task.',
});

// Authentication — block password brute-force and mass account creation.
const authLimiter = makeLimiter({
  limit: 10,
  message: 'Too many authentication attempts. Please wait a moment before trying again.',
});

// Python file engine — each request spawns an interpreter (OCR/conversion can
// run up to 120s), so throttle to prevent process-exhaustion.
const fileProcessLimiter = makeLimiter({
  limit: 20,
  message: 'Too many file-processing requests. Please wait a moment before uploading more files.',
});

module.exports = { chatLimiter, ttsLimiter, fileAskLimiter, authLimiter, fileProcessLimiter };