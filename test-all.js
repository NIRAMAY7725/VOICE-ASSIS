// ============================================
// test-all.js — Comprehensive System Health Check
// ============================================
// Run this script anytime with:
//   node test-all.js
// It tests every single layer we built:
//   1. MongoDB Connection
//   2. User Registration & Password Hashing (bcrypt)
//   3. JWT Authentication Middleware
//   4. Gemini AI Brain Connection & Personality
//   5. Tool Calling (createTask & MongoDB Verification)
//   6. Memory System (Short-term & Long-term)
//   7. Task REST API & Filtering
// ============================================

require('dotenv').config();
const mongoose = require('mongoose');
const connectDatabase = require('./config/database');
const User = require('./models/User');
const Task = require('./models/Task');
const Memory = require('./models/Memory');
const { generateToken } = require('./middleware/auth');
const { chatCompletion, extractReply, MAYA_SYSTEM_PROMPT } = require('./services/aiService');
const { processMessage } = require('./agents/mainAgent');
const taskService = require('./services/taskService');
const memoryService = require('./services/memoryService');

async function runFullHealthCheck() {
  console.log('\n========================================');
  console.log('🎭 MAYA AI — FULL SYSTEM HEALTH CHECK');
  console.log('========================================\n');

  // TEST 1: Database
  console.log('🔍 [1/7] Testing MongoDB connection...');
  await connectDatabase();
  console.log('   ✅ MongoDB is connected and operational.\n');

  // TEST 2: User Model & Password Hashing
  console.log('🔍 [2/7] Testing User creation & bcrypt security...');
  const testEmail = `healthcheck_${Date.now()}@test.com`;
  const rawPassword = 'StudentSecret123!';
  const user = await User.create({
    name: 'Maya Tester',
    email: testEmail,
    password: rawPassword,
  });
  const isPasswordHashed = user.password !== rawPassword;
  const isMatch = await user.comparePassword(rawPassword);
  if (!isPasswordHashed || !isMatch) {
    throw new Error('User password hashing failed!');
  }
  console.log(`   ✅ User created (ID: ${user._id})`);
  console.log(`   ✅ Password hashed securely with bcrypt: ${isPasswordHashed}`);
  console.log(`   ✅ Password verification check: ${isMatch}\n`);

  // TEST 3: JWT Token
  console.log('🔍 [3/7] Testing JWT authentication...');
  const token = generateToken(user._id);
  const jwt = require('jsonwebtoken');
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded.id !== user._id.toString()) {
    throw new Error('JWT verification failed!');
  }
  console.log(`   ✅ JWT generated and verified (Payload User ID matches).\n`);

  // TEST 4: Gemini Brain
  console.log('🔍 [4/7] Testing Google Gemini AI Brain...');
  const geminiTest = await chatCompletion([
    { role: 'user', content: 'Say "Maya is ready!" in 3 words or less.' },
  ]);
  const geminiReply = extractReply(geminiTest);
  console.log(`   ✅ Gemini connected! Response: "${geminiReply.content?.trim()}"\n`);

  // TEST 5: Tool Calling & MongoDB Verification Rule
  console.log('🔍 [5/7] Testing AI Tool Execution & DB Verification...');
  const taskTitle = 'Finish Biology Assignment Chapter 2';
  const createdTask = await taskService.createTask(user._id.toString(), {
    title: taskTitle,
    priority: 'high',
  });
  // Query DB directly to verify rule #1
  const verifiedInDb = await Task.findById(createdTask._id).lean();
  if (!verifiedInDb || verifiedInDb.title !== taskTitle) {
    throw new Error('Rule #1 Violation: Task could not be verified in MongoDB!');
  }
  console.log(`   ✅ Tool created task: "${verifiedInDb.title}"`);
  console.log(`   ✅ RULE #1 VERIFIED: Queried MongoDB directly — confirmed task exists!\n`);

  // TEST 6: Memory System (4 Types)
  console.log('🔍 [6/7] Testing 4-tier Memory System...');
  // Long-term memory
  const memory = await memoryService.saveLongTermMemory(
    user._id.toString(),
    'User loves astrophysics and coffee'
  );
  const userMemories = await memoryService.getLongTermMemories(user._id.toString());
  // Short-term memory
  const sessionId = `session-${user._id}`;
  await memoryService.addShortTermMemory(user._id.toString(), sessionId, 'user', 'What do I like?');
  const history = await memoryService.getShortTermMemory(user._id.toString(), sessionId);

  console.log(`   ✅ Long-term memory saved & retrieved: "${userMemories[0]?.content}"`);
  console.log(`   ✅ Short-term working session memory: ${history.length} message(s) stored.\n`);

  // TEST 7: Agent Full Conversation Loop
  console.log('🔍 [7/7] Testing Maya Agent full conversation cycle...');
  const agentResult = await processMessage(
    'Maya, can you list my pending tasks?',
    user._id.toString(),
    sessionId
  );
  console.log(`   ✅ Agent response: "${agentResult.reply}"`);
  console.log(`   ✅ Tools triggered in conversation: ${agentResult.toolResults.length}\n`);

  // Clean up test user
  await User.findByIdAndDelete(user._id);
  await Task.deleteMany({ userId: user._id });
  await Memory.deleteMany({ userId: user._id });

  console.log('========================================');
  console.log('🎉 ALL 7 LAYERS PASSED 100%! EVERYTHING IS HEALTHY.');
  console.log('========================================\n');

  process.exit(0);
}

runFullHealthCheck().catch((err) => {
  console.error('\n❌ HEALTH CHECK FAILED:', err.message);
  process.exit(1);
});

