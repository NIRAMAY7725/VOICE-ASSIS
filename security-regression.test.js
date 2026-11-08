// ============================================
// tests/security-regression.test.js — Stage 1 regressions
// ============================================
// One test per Stage-1 security fix (AUDIT.md BE-S1…S10, BE-V2).
// Run from backend/:  npm test   (or: node --test tests/)
//
// Requires the local MongoDB to be running (same as the app) and the
// Python engine venv for the /health cache test. No external AI or
// Microsoft TTS calls are made — validation failures reject before
// synthesis, and limiter/401 tests never reach a service.
//
// NOTE: rate limiters are module-level singletons, so the tests that
// exhaust a limiter run LAST. node:test executes this file in its own
// process, giving every run a fresh limiter state.
// ============================================

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const request = require('supertest');
const mongoose = require('mongoose');

// Requiring server.js loads .env and builds the app WITHOUT listening
// (startServer only runs when server.js is the entry point).
const { app } = require('../server');
const { toolArgSchemas } = require('../tools/toolArgs');
const { buildEngineEnv } = require('../services/pythonEngineClient');
const { AI_TIMEOUT_MS, AI_MAX_RETRIES } = require('../services/aiService');
const { generateToken } = require('../middleware/auth');
const User = require('../models/User');

const BACKEND_DIR = path.join(__dirname, '..');

let testUser = null;
let token = null;

before(async () => {
  // Connect directly (not via config/database.js, which process.exit()s
  // on failure and would kill the test runner without a report).
  await mongoose.connect(process.env.MONGODB_URI);
  testUser = await User.create({
    name: 'Regression Test',
    email: `regression_${Date.now()}@test.local`,
    password: 'regression-test-password',
  });
  token = generateToken(testUser._id);
});

after(async () => {
  if (testUser) await User.deleteOne({ _id: testUser._id });
  await mongoose.disconnect();
});

// ---------------------------------------------------------------
// BE-S5 — AI tool arguments are validated and unknown keys stripped
// ---------------------------------------------------------------

test('BE-S5: createTask args strip injected userId and $-operators', () => {
  const parsed = toolArgSchemas.createTask.parse({
    title: 'Study math',
    priority: 'high',
    userId: 'someone-elses-id',
    $where: 'function() { return true; }',
  });
  assert.equal(parsed.title, 'Study math');
  assert.equal(parsed.priority, 'high');
  assert.equal(Object.hasOwn(parsed, 'userId'), false);
  assert.equal(Object.hasOwn(parsed, '$where'), false);
});

test('BE-S5: updateTask rejects a non-ObjectId taskId', () => {
  assert.throws(
    () => toolArgSchemas.updateTask.parse({ taskId: 'not-an-id', status: 'completed' }),
    { name: 'ZodError' }
  );
});

test('BE-S5: updateTask accepts a valid ObjectId and strips extras', () => {
  const parsed = toolArgSchemas.updateTask.parse({
    taskId: '507f1f77bcf86cd799439011',
    status: 'completed',
    userId: 'evil',
  });
  assert.equal(parsed.status, 'completed');
  assert.equal(Object.hasOwn(parsed, 'userId'), false);
});

test('BE-S5: createReminder requires an ISO datetime', () => {
  assert.throws(
    () => toolArgSchemas.createReminder.parse({ title: 'x', reminderDate: 'tomorrow' }),
    { name: 'ZodError' }
  );
  const parsed = toolArgSchemas.createReminder.parse({
    title: 'Take a break',
    reminderDate: '2026-11-07T10:00:00Z',
  });
  assert.equal(parsed.title, 'Take a break');
});

test('BE-S5: getTasks rejects unknown enum values', () => {
  assert.throws(
    () => toolArgSchemas.getTasks.parse({ status: 'bogus' }),
    { name: 'ZodError' }
  );
});

test('BE-S5: saveMemory strips unknown keys and bounds content length', () => {
  const parsed = toolArgSchemas.saveMemory.parse({ content: 'User likes tea', role: 'system' });
  assert.equal(Object.hasOwn(parsed, 'role'), false);
  assert.throws(
    () => toolArgSchemas.saveMemory.parse({ content: 'x'.repeat(5001) }),
    { name: 'ZodError' }
  );
});

test('BE-S5: createTask rejects empty and overlong titles', () => {
  assert.throws(() => toolArgSchemas.createTask.parse({ title: '' }), { name: 'ZodError' });
  assert.throws(() => toolArgSchemas.createTask.parse({ title: 'x'.repeat(201) }), { name: 'ZodError' });
});

// ---------------------------------------------------------------
// BE-S10 — Python engine child env is an allowlist, not a full copy
// ---------------------------------------------------------------

test('BE-S10: engine env excludes every secret and keeps required vars', () => {
  const env = buildEngineEnv();
  const keys = Object.keys(env).map((k) => k.toUpperCase());
  for (const secret of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'JWT_SECRET', 'MONGODB_URI', 'AI_MODEL']) {
    assert.equal(keys.includes(secret), false, `${secret} must not leak into the engine env`);
  }
  assert.equal(env.PYTHONIOENCODING, 'utf-8');
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  // PATH is allowlisted so the engine can find installed binaries.
  assert.ok(keys.includes('PATH'));
});

test('BE-S10: engine env passes through explicit binary overrides', () => {
  const original = process.env.MAYA_TESSERACT_CMD;
  process.env.MAYA_TESSERACT_CMD = 'C:/dummy/tesseract.exe';
  try {
    const env = buildEngineEnv();
    assert.equal(env.MAYA_TESSERACT_CMD, 'C:/dummy/tesseract.exe');
  } finally {
    if (original === undefined) delete process.env.MAYA_TESSERACT_CMD;
    else process.env.MAYA_TESSERACT_CMD = original;
  }
});

// ---------------------------------------------------------------
// BE-B1 — AI client has bounded timeout and retries
// ---------------------------------------------------------------

test('BE-B1: AI client timeout is 30s with at most 1 retry', () => {
  assert.equal(AI_TIMEOUT_MS, 30_000);
  assert.equal(AI_MAX_RETRIES, 1);
});

// ---------------------------------------------------------------
// BE-S4 — production refuses to start without JWT_SECRET
// ---------------------------------------------------------------

// Build a child env with case-variant-safe overrides (Windows env is
// case-insensitive). Dummy values only — never the real secret.
function childEnvWith(overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(overrides)) {
    for (const existing of Object.keys(env)) {
      if (existing.toUpperCase() === key.toUpperCase()) delete env[existing];
    }
    env[key] = overrides[key];
  }
  return env;
}

test('BE-S4: production + missing JWT_SECRET refuses to load auth module', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', "require('./middleware/auth')"],
    { cwd: BACKEND_DIR, env: childEnvWith({ NODE_ENV: 'production', JWT_SECRET: '' }), encoding: 'utf8' }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JWT_SECRET must be set in production/);
});

test('BE-S4: production + explicit JWT_SECRET loads normally', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', "require('./middleware/auth')"],
    { cwd: BACKEND_DIR, env: childEnvWith({ NODE_ENV: 'production', JWT_SECRET: 'dummy-test-secret' }), encoding: 'utf8' }
  );
  assert.equal(result.status, 0);
});

test('BE-S4: development without JWT_SECRET still starts (with warning)', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', "require('./middleware/auth')"],
    { cwd: BACKEND_DIR, env: childEnvWith({ NODE_ENV: 'development', JWT_SECRET: '' }), encoding: 'utf8' }
  );
  assert.equal(result.status, 0);
});

// ---------------------------------------------------------------
// BE-S1 — file-processing routes require JWT; /health stays public
// ---------------------------------------------------------------

const PROTECTED_PROCESSING_ROUTES = [
  ['post', '/api/file-processing/process'],
  ['post', '/api/file-processing/tabular'],
  ['post', '/api/file-processing/spreadsheet'],
  ['post', '/api/file-processing/pdf'],
  ['post', '/api/file-processing/ocr'],
  ['post', '/api/file-processing/convert'],
  ['post', '/api/file-processing/json'],
  ['post', '/api/file-processing/archive'],
  ['post', '/api/file-processing/utils'],
  ['get', '/api/file-processing/convert/formats'],
  ['get', '/api/file-processing/utils/status'],
];

for (const [method, route] of PROTECTED_PROCESSING_ROUTES) {
  test(`BE-S1: ${method.toUpperCase()} ${route} without token → 401`, async () => {
    const res = await request(app)[method](route);
    assert.equal(res.status, 401);
    assert.equal(res.body.success, false);
  });
}

test('BE-S1: GET /api/file-processing/health stays public', { timeout: 20_000 }, async () => {
  const res = await request(app).get('/api/file-processing/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('BE-S1: engine health is cached on the second call', async () => {
  // First call above warmed the cache; this one must not respawn Python.
  const started = Date.now();
  const res = await request(app).get('/api/file-processing/health');
  const elapsed = Date.now() - started;
  assert.equal(res.status, 200);
  assert.equal(res.body.cached, true);
  assert.ok(elapsed < 500, `cached health took ${elapsed}ms — expected no process spawn`);
});

// ---------------------------------------------------------------
// BE-S2 — neural TTS requires JWT; /voices stays public
// ---------------------------------------------------------------

test('BE-S2: POST /api/voice/tts without token → 401', async () => {
  const res = await request(app).post('/api/voice/tts').send({ text: 'hello' });
  assert.equal(res.status, 401);
});

test('BE-S2: GET /api/voice/voices stays public', async () => {
  const res = await request(app).get('/api/voice/voices');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.voices));
  assert.ok(res.body.voices.length > 0);
});

// ---------------------------------------------------------------
// BE-S6 — TTS voice/rate/pitch are validated before SSML interpolation
// (These use a valid token but invalid params, so they reject at the
// Zod layer and never reach the external Edge-TTS service.)
// ---------------------------------------------------------------

test('BE-S6: TTS rejects a voice outside the curated whitelist', async () => {
  const res = await request(app)
    .post('/api/voice/tts')
    .set('Authorization', `Bearer ${token}`)
    .send({ text: 'hello', voice: 'en-US-Evil"><break time="5000ms"/>' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Unknown voice/);
});

test('BE-S6: TTS rejects malformed rate', async () => {
  const res = await request(app)
    .post('/api/voice/tts')
    .set('Authorization', `Bearer ${token}`)
    .send({ text: 'hello', rate: '0%"/><injection x="' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Rate must look like/);
});

test('BE-S6: TTS rejects malformed pitch', async () => {
  const res = await request(app)
    .post('/api/voice/tts')
    .set('Authorization', `Bearer ${token}`)
    .send({ text: 'hello', pitch: 'fast' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Pitch must look like/);
});

test('BE-S6: TTS still rejects empty text for a signed-in user', async () => {
  const res = await request(app)
    .post('/api/voice/tts')
    .set('Authorization', `Bearer ${token}`)
    .send({ text: '' });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------
// BE-V2 — voice/process shares the chat limiter (mount check below)
// ---------------------------------------------------------------

test('BE-V2: POST /api/voice/process without token → 401', async () => {
  const res = await request(app).post('/api/voice/process').send({ text: 'hello' });
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------
// LIMITER MOUNTS — these exhaust budgets, so they run LAST.
// ---------------------------------------------------------------

test('BE-S1: fileProcessLimiter allows 20/min then 429 (with token, no files)', async () => {
  // No files → 400 before any engine spawn; cheap way to probe the mount.
  const statuses = [];
  for (let i = 0; i < 21; i++) {
    const res = await request(app)
      .post('/api/file-processing/process')
      .set('Authorization', `Bearer ${token}`);
    statuses.push(res.status);
  }
  assert.equal(statuses[0], 400);
  assert.equal(statuses[19], 400);
  assert.equal(statuses[20], 429);
});

test('BE-S3: authLimiter allows 10/min on login then 429', async () => {
  // Invalid body → Zod 400 before any DB access.
  const statuses = [];
  for (let i = 0; i < 11; i++) {
    const res = await request(app).post('/api/agent/login').send({ email: 'bad', password: '' });
    statuses.push(res.status);
  }
  assert.equal(statuses[0], 400);
  assert.equal(statuses[9], 400);
  assert.equal(statuses[10], 429);
});

test('BE-S3: register shares the auth limiter mount', async () => {
  // Budget already exhausted by the login test → register must also 429.
  const res = await request(app).post('/api/agent/register').send({ email: 'bad', password: '' });
  assert.equal(res.status, 429);
});

test('BE-V2: voice/process is mounted behind chatLimiter (30/min)', async () => {
  const statuses = [];
  for (let i = 0; i < 31; i++) {
    const res = await request(app).post('/api/voice/process').send({ text: 'hello' });
    statuses.push(res.status);
  }
  assert.equal(statuses[0], 401);
  assert.equal(statuses[statuses.length - 1], 429);
});

test('BE-S2: ttsLimiter still mounts on /api/voice/tts (30/min)', async () => {
  const statuses = [];
  for (let i = 0; i < 31; i++) {
    const res = await request(app).post('/api/voice/tts').send({ text: 'hello' });
    statuses.push(res.status);
  }
  assert.equal(statuses[0], 401);
  assert.equal(statuses[statuses.length - 1], 429);
});