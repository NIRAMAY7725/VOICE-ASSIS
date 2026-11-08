// ============================================
// tests/latency.test.js — Part 1 latency regressions
// ============================================
// Run from backend/:  npm test
// AI streams are STUBBED here (no external calls, no token spend):
// mainAgent calls aiService.streamChatCompletion through the module
// namespace precisely so these tests can replace it deterministically.
// Requires local MongoDB (same as the app). Test user + memories are
// cleaned up afterwards.
// ============================================

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

const { app } = require('../server'); // loads .env, builds app, no listen
const aiService = require('../services/aiService');
const memoryService = require('../services/memoryService');
const { generateToken } = require('../middleware/auth');
const User = require('../models/User');
const Memory = require('../models/Memory');

const realStream = aiService.streamChatCompletion;
let testUser = null;
let token = null;

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  testUser = await User.create({
    name: 'Latency Test',
    email: `latency_${Date.now()}@test.local`,
    password: 'latency-test-password',
  });
  token = generateToken(testUser._id);
});

after(async () => {
  aiService.streamChatCompletion = realStream;
  if (testUser) {
    await Memory.deleteMany({ userId: testUser._id });
    await User.deleteOne({ _id: testUser._id });
  }
  await mongoose.disconnect();
});

// Temporarily override env vars for a single fn (restores afterwards).
function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// ---------------------------------------------------------------
// 1. Model routing
// ---------------------------------------------------------------

test('routing: routine chat goes to FAST_MODEL', () => {
  withEnv({ FAST_MODEL: 'fast-test-model', HEAVY_MODEL: 'heavy-test-model', AI_MODEL: undefined }, () => {
    assert.equal(aiService.routeModel('hey, how are you?'), 'fast-test-model');
    assert.equal(aiService.routeModel('add a task to buy milk'), 'fast-test-model');
    assert.equal(aiService.routeModel('thanks!'), 'fast-test-model');
  });
});

test('routing: explicit "detailed" goes to HEAVY_MODEL', () => {
  withEnv({ FAST_MODEL: 'fast-test-model', HEAVY_MODEL: 'heavy-test-model', AI_MODEL: undefined }, () => {
    assert.equal(aiService.routeModel('give me a detailed plan'), 'heavy-test-model');
    assert.equal(aiService.routeModel('explain this in depth please'), 'heavy-test-model');
    assert.equal(aiService.routeModel('a comprehensive summary'), 'heavy-test-model');
  });
});

test('routing: long-form story writing goes to HEAVY_MODEL', () => {
  withEnv({ FAST_MODEL: 'fast-test-model', HEAVY_MODEL: 'heavy-test-model', AI_MODEL: undefined }, () => {
    assert.equal(aiService.routeModel('write a story about a space explorer'), 'heavy-test-model');
    assert.equal(aiService.routeModel('continue the chapter please'), 'heavy-test-model');
    // A short non-writing mention stays fast:
    assert.equal(aiService.routeModel('I read a story today'), 'fast-test-model');
  });
});

test('routing: complex study explanations go to HEAVY_MODEL', () => {
  withEnv({ FAST_MODEL: 'fast-test-model', HEAVY_MODEL: 'heavy-test-model', AI_MODEL: undefined }, () => {
    const long = 'explain how photosynthesis works at the molecular level, including the light-dependent reactions, the Calvin cycle, and how ATP and NADPH are produced and consumed in each stage';
    assert.equal(aiService.routeModel(long), 'heavy-test-model');
    assert.equal(aiService.routeModel('explain cats'), 'fast-test-model'); // short + simple
  });
});

test('routing: env vars are configurable, AI_MODEL stays as legacy fallback', () => {
  withEnv({ FAST_MODEL: undefined, HEAVY_MODEL: undefined, AI_MODEL: 'legacy-model' }, () => {
    assert.equal(aiService.getModelConfig().fast, 'legacy-model');
  });
  withEnv({ FAST_MODEL: undefined, HEAVY_MODEL: undefined, AI_MODEL: undefined }, () => {
    const config = aiService.getModelConfig();
    assert.ok(config.fast.length > 0);
    assert.ok(config.heavy.length > 0);
    assert.notEqual(config.fast, config.heavy);
  });
});

test('routing: voice mode has a short prompt and a lower token budget', () => {
  assert.ok(aiService.MAYA_VOICE_SYSTEM_PROMPT.length < aiService.MAYA_SYSTEM_PROMPT.length);
  assert.ok(aiService.VOICE_MAX_TOKENS <= 512);
  assert.ok(aiService.VOICE_MAX_TOKENS >= 128);
});

// ---------------------------------------------------------------
// 2. Sliding window + token cap
// ---------------------------------------------------------------

test('memory: trimToWindow keeps only the last N messages', () => {
  const messages = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
  const trimmed = memoryService.trimToWindow(messages, 6, 10000);
  assert.equal(trimmed.length, 6);
  assert.equal(trimmed[0].content, 'msg 6');
  assert.equal(trimmed[5].content, 'msg 11');
});

test('memory: token cap drops oldest messages first', () => {
  const messages = [
    { role: 'user', content: 'x'.repeat(400) }, // ~100 tokens
    { role: 'assistant', content: 'y'.repeat(400) }, // ~100 tokens
    { role: 'user', content: 'latest question' },
  ];
  const trimmed = memoryService.trimToWindow(messages, 10, 100);
  // Newest always kept; the two bulky older messages are dropped.
  assert.equal(trimmed.length, 1);
  assert.equal(trimmed[0].content, 'latest question');
});

test('memory: newest message survives even if it alone exceeds the cap', () => {
  const messages = [{ role: 'user', content: 'z'.repeat(4000) }];
  const trimmed = memoryService.trimToWindow(messages, 6, 100);
  assert.equal(trimmed.length, 1);
});

test('memory: empty and non-array inputs are safe', () => {
  assert.deepEqual(memoryService.trimToWindow([]), []);
  assert.deepEqual(memoryService.trimToWindow(null), []);
  assert.equal(memoryService.estimateTokens('abcd'), 1);
  assert.equal(memoryService.estimateTokens('abcde'), 2);
});

test('memory: stored history is windowed on read (integration)', async () => {
  const sid = `window-test-${Date.now()}`;
  const userId = testUser._id.toString();
  for (let i = 0; i < 8; i++) {
    await memoryService.addShortTermMemory(userId, sid, i % 2 ? 'assistant' : 'user', `message ${i}`);
  }
  const history = await memoryService.getShortTermMemory(userId, sid);
  const windowSize = Math.max(2, parseInt(process.env.MEMORY_WINDOW_MESSAGES, 10) || 6);
  assert.equal(history.length, windowSize);
  assert.equal(history[history.length - 1].content, 'message 7');
  await memoryService.clearShortTermMemory(userId, sid);
});

// ---------------------------------------------------------------
// 3. SSE streaming endpoint
// ---------------------------------------------------------------

test('SSE: requires auth (401 without token)', async () => {
  const res = await request(app).post('/api/agent/chat/stream').send({ message: 'hi' });
  assert.equal(res.status, 401);
});

test('SSE: validates body before switching to event-stream (400)', async () => {
  const res = await request(app)
    .post('/api/agent/chat/stream')
    .set('Authorization', `Bearer ${token}`)
    .send({ message: '' });
  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
});

test('SSE: streams token events then done, with correct headers', async () => {
  aiService.streamChatCompletion = async function* () {
    yield { choices: [{ delta: { content: 'Hello ' } }] };
    yield { choices: [{ delta: { content: 'there, friend.' } }] };
  };
  try {
    const res = await request(app)
      .post('/api/agent/chat/stream')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'hi', sessionId: `sse-basic-${Date.now()}` });

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    assert.match(res.headers['cache-control'], /no-cache/);
    assert.equal(res.headers['connection'], 'keep-alive');

    const events = res.text.split('\n\n').filter(Boolean);
    const tokenEvents = events.filter((e) => e.startsWith('event: token'));
    assert.equal(tokenEvents.length, 2);
    assert.match(tokenEvents[0], /"text":"Hello "/);

    const doneEvent = events.find((e) => e.startsWith('event: done'));
    assert.ok(doneEvent, 'done event missing');
    const donePayload = JSON.parse(doneEvent.split('data: ')[1]);
    assert.equal(donePayload.reply, 'Hello there, friend.');
    assert.deepEqual(donePayload.toolResults, []);
  } finally {
    aiService.streamChatCompletion = realStream;
  }
});

test('SSE: fragmented tool-call deltas are merged, validated and executed', async () => {
  let call = 0;
  aiService.streamChatCompletion = async function* () {
    call++;
    if (call === 1) {
      // getTasks tool call arriving in fragments (real providers split these)
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'getTasks', arguments: '' } }] } }] };
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"sta' } }] } }] };
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'tus":"pending"}' } }] } }] };
    } else {
      yield { choices: [{ delta: { content: 'Here are your tasks.' } }] };
    }
  };
  try {
    const res = await request(app)
      .post('/api/agent/chat/stream')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'show my tasks', sessionId: `sse-tools-${Date.now()}` });

    assert.equal(res.status, 200);
    const doneEvent = res.text.split('\n\n').find((e) => e.startsWith('event: done'));
    assert.ok(doneEvent);
    const donePayload = JSON.parse(doneEvent.split('data: ')[1]);
    assert.equal(donePayload.reply, 'Here are your tasks.');
    assert.equal(donePayload.toolResults.length, 1);
    assert.equal(donePayload.toolResults[0].tool, 'getTasks');
    assert.equal(donePayload.toolResults[0].result.success, true);
    assert.deepEqual(donePayload.toolResults[0].args, { status: 'pending' });
  } finally {
    aiService.streamChatCompletion = realStream;
  }
});

test('SSE: client disconnect aborts the upstream LLM request', { timeout: 10_000 }, async () => {
  let signalEntered;
  let signalAborted;
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  const aborted = new Promise((resolve) => { signalAborted = resolve; });

  aiService.streamChatCompletion = async function* (messages, tools, options, signal) {
    signalEntered();
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        signalAborted();
        const error = new Error('The request was aborted.');
        error.name = 'AbortError';
        reject(error);
      });
    });
    yield {}; // never reached
  };

  try {
    const req = request(app)
      .post('/api/agent/chat/stream')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'hi', sessionId: `sse-abort-${Date.now()}` });
    req.catch(() => {}); // start the request; swallow the expected abort error

    await entered;
    req.abort();
    await aborted; // fails the test by timeout if the route never aborts upstream
    assert.ok(true);
  } finally {
    aiService.streamChatCompletion = realStream;
  }
});

test('SSE: sends a heartbeat comment during a long generation', { timeout: 25_000 }, async () => {
  aiService.streamChatCompletion = async function* () {
    // Stall past the 15s heartbeat interval, then finish.
    await new Promise((resolve) => setTimeout(resolve, 16_000));
    yield { choices: [{ delta: { content: 'Slow answer.' } }] };
  };
  try {
    const res = await request(app)
      .post('/api/agent/chat/stream')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'hi', sessionId: `sse-heartbeat-${Date.now()}` });
    assert.equal(res.status, 200);
    assert.match(res.text, /: heartbeat/);
    assert.match(res.text, /event: done/);
  } finally {
    aiService.streamChatCompletion = realStream;
  }
});

test('SSE: upstream failure becomes an error event, not a crash', async () => {
  aiService.streamChatCompletion = async function* () {
    throw new Error('AI Service error: simulated upstream failure');
    yield {}; // eslint-disable-line no-unreachable
  };
  try {
    const res = await request(app)
      .post('/api/agent/chat/stream')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'hi', sessionId: `sse-error-${Date.now()}` });
    assert.equal(res.status, 200); // headers already sent; error travels as an event
    const errorEvent = res.text.split('\n\n').find((e) => e.startsWith('event: error'));
    assert.ok(errorEvent, 'error event missing');
    assert.match(errorEvent, /Something went wrong/);
    // Raw upstream details must not leak to the client.
    assert.equal(res.text.includes('simulated upstream failure'), false);
  } finally {
    aiService.streamChatCompletion = realStream;
  }
});