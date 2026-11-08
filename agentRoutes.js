// ============================================
// routes/agentRoutes.js — Chat & Auth Endpoints
// ============================================
// WHY THIS FILE?
// Handles all agent-related HTTP endpoints:
//   POST /api/agent/chat      → Send a message to Maya
//   POST /api/agent/register  → Create a new account
//   POST /api/agent/login     → Log in and get a JWT
//
// These are the core endpoints the frontend talks to.
// ============================================

const express = require('express');
const { z } = require('zod');
const User = require('../models/User');
const { protect, generateToken } = require('../middleware/auth');
const { processMessage, processMessageStream } = require('../agents/mainAgent');

const router = express.Router();

// ===================== ZOD SCHEMAS =====================
// Zod validates incoming data BEFORE it reaches our logic.
// If validation fails, the user gets a clear error message.

const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(50),
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

const chatSchema = z.object({
  message: z.string().min(1, 'Message cannot be empty').max(2000),
  sessionId: z.string().optional(),
  voiceMode: z.boolean().optional(), // shorter, spoken-style replies
});

// ===================== ROUTES =====================

// -------------------------------------------------
// POST /api/agent/register — Create a new user
// -------------------------------------------------
router.post('/register', async (req, res) => {
  try {
    // 1. Validate the input
    const data = registerSchema.parse(req.body);

    // 2. Check if user already exists
    const existingUser = await User.findOne({ email: data.email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'An account with this email already exists.',
      });
    }

    // 3. Create the user (password is auto-hashed by the pre-save hook)
    const user = await User.create({
      name: data.name,
      email: data.email,
      password: data.password,
    });

    // 4. Generate a JWT so they're logged in immediately
    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    // Zod validation errors have a special format
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: error.issues.map((e) => e.message).join(', '),
      });
    }
    console.error('Register error:', error);
    res.status(500).json({ success: false, error: 'Server error during registration.' });
  }
});

// -------------------------------------------------
// POST /api/agent/login — Log in
// -------------------------------------------------
router.post('/login', async (req, res) => {
  try {
    // 1. Validate
    const data = loginSchema.parse(req.body);

    // 2. Find user by email (include password for comparison)
    const user = await User.findOne({ email: data.email }).select('+password');
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password.',
      });
    }

    // 3. Compare passwords
    const isMatch = await user.comparePassword(data.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password.',
      });
    }

    // 4. Generate token
    const token = generateToken(user._id);

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: error.issues.map((e) => e.message).join(', '),
      });
    }
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Server error during login.' });
  }
});

// -------------------------------------------------
// POST /api/agent/chat — Send a message to Maya
// -------------------------------------------------
// Protected: requires a valid JWT token
router.post('/chat', protect, async (req, res) => {
  try {
    // 1. Validate
    const data = chatSchema.parse(req.body);

    // 2. Process through the main agent
    const result = await processMessage(
      data.message,
      req.user._id.toString(),
      data.sessionId,
      { voiceMode: data.voiceMode === true }
    );

    // 3. Return Maya's reply
    res.json({
      success: true,
      reply: result.reply,
      toolResults: result.toolResults,
    });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: error.issues.map((e) => e.message).join(', '),
      });
    }
    console.error('Chat error:', error);
    res.status(500).json({
      success: false,
      error: 'Something went wrong while processing your message.',
    });
  }
});

// -------------------------------------------------
// POST /api/agent/chat/stream — SSE streaming chat
// -------------------------------------------------
// Streams the reply as Server-Sent Events so the first token arrives
// immediately instead of after the full generation:
//   event: token  data: {"text":"..."}   (incremental content)
//   event: done   data: {"reply":"...","toolResults":[...]}
//   event: error  data: {"error":"..."}
// A `: heartbeat` comment every 15s keeps proxies from timing out.
// If the client disconnects, the upstream LLM request is aborted.
// -------------------------------------------------
const SSE_HEARTBEAT_MS = 15_000;

router.post('/chat/stream', protect, async (req, res) => {
  // Validate BEFORE switching to SSE so bad requests get a normal JSON 400.
  let data;
  try {
    data = chatSchema.parse(req.body);
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.name === 'ZodError'
        ? error.issues.map((e) => e.message).join(', ')
        : 'Invalid request.',
    });
  }

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering (nginx etc.)
  });
  res.flushHeaders();

  // Abort the upstream LLM call if the client goes away mid-stream.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, SSE_HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  const send = (event, payload) => {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
  };

  const startedAt = Date.now();
  let firstTokenAt = null;

  try {
    const result = await processMessageStream(
      data.message,
      req.user._id.toString(),
      data.sessionId,
      {
        signal: controller.signal,
        voiceMode: data.voiceMode === true,
        onToken: (text) => {
          if (firstTokenAt === null) {
            firstTokenAt = Date.now();
            console.log(`⚡ chat/stream TTFT: ${firstTokenAt - startedAt}ms`);
          }
          send('token', { text });
        },
      }
    );
    console.log(`⚡ chat/stream total: ${Date.now() - startedAt}ms`);
    send('done', { reply: result.reply, toolResults: result.toolResults });
  } catch (error) {
    if (controller.signal.aborted || error.name === 'APIUserAbortError' || error.name === 'AbortError') {
      console.log('⚡ chat/stream: client disconnected — upstream request aborted.');
    } else {
      console.error('Stream chat error:', error.message);
      send('error', { error: 'Something went wrong while processing your message.' });
    }
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});

module.exports = router;

