// ============================================
// server.js — Express Application Entry Point
// ============================================
// WHY THIS FILE?
// This is where everything comes together. It:
//   1. Loads environment variables from .env
//   2. Connects to MongoDB
//   3. Sets up Express middleware (CORS, security, logging)
//   4. Mounts all route modules
//   5. Serves the frontend static files
//   6. Starts the HTTP server
//
// RUN IT:
//   npm run dev   (with nodemon, auto-restarts on changes)
//   npm start     (production)
// ============================================

// Load .env FIRST — before anything else reads process.env
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const connectDatabase = require('./config/database');
const { chatLimiter, ttsLimiter, fileAskLimiter, authLimiter } = require('./middleware/rateLimit');

// Import route modules
const agentRoutes = require('./routes/agentRoutes');
const taskRoutes = require('./routes/taskRoutes');
const voiceRoutes = require('./routes/voiceRoutes');
const fileRoutes = require('./routes/fileAssistant');
const fileProcessingRoutes = require('./routes/fileProcessing');

// Create the Express app
const app = express();

// ===================== MIDDLEWARE =====================

// Security headers (protects against common web vulnerabilities)
app.use(helmet({
  contentSecurityPolicy: false, // Disabled for dev; enable in production
}));

// CORS — allows the frontend to talk to the backend
// In development, both may be on different ports/origins
app.use(cors({
  origin: '*',  // Allow all origins in dev; restrict in production
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Parse JSON request bodies (so we can read req.body)
app.use(express.json({ limit: '10mb' }));

// Parse URL-encoded bodies (for form submissions)
app.use(express.urlencoded({ extended: true }));

// HTTP request logger (shows requests in the console)
// "dev" format: :method :url :status :response-time ms
app.use(morgan('dev'));

// ===================== STATIC FILES =====================
// Serve the frontend from the /frontend directory
// This means you can access index.html at http://localhost:3000/
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ===================== API ROUTES =====================
// Rate-limit the expensive AI endpoints before they reach their routers.
// These run first; on success they call next() and the router handles the request.
app.post('/api/agent/chat', chatLimiter);
app.post('/api/agent/chat/stream', chatLimiter); // SSE streaming shares the chat budget
app.post('/api/voice/tts', ttsLimiter);
app.post('/api/voice/process', chatLimiter); // voice chat runs the full agent loop
app.post('/api/file-assistant/ask', fileAskLimiter);
app.post('/api/agent/login', authLimiter);
app.post('/api/agent/register', authLimiter);

app.use('/api/agent', agentRoutes);    // /api/agent/chat, /register, /login
app.use('/api/tasks', taskRoutes);     // /api/tasks CRUD
app.use('/api/voice', voiceRoutes);    // /api/voice/process
app.use('/api/file-assistant', fileRoutes); // /api/file-assistant/*
app.use('/api/file-processing', fileProcessingRoutes); // Python engine: /health, /process

// ===================== HEALTH CHECK =====================
// Simple endpoint to verify the server is running
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: '🎭 Maya AI is running!',
    timestamp: new Date().toISOString(),
  });
});

// ===================== FALLBACK =====================
// Unknown API routes return JSON; every other route serves the SPA shell.
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: 'API route not found.' });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// ===================== ERROR HANDLER =====================
// Global error handler — catches any unhandled errors
app.use((err, req, res, next) => {
  console.error('💥 Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'development'
      ? err.message
      : 'Internal server error',
  });
});

// ===================== START SERVER =====================
const PORT = process.env.PORT || 3000;

async function startServer() {
  // 1. Connect to MongoDB
  await connectDatabase();

  // 2. Start listening
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║      🎭 MAYA AI Server is running!       ║
║                                          ║
║   Local:  http://localhost:${PORT}          ║
║   Mode:   ${process.env.NODE_ENV || 'development'}              ║
║                                          ║
║   API:    /api/agent/chat                ║
║           /api/tasks                     ║
║           /api/voice/process             ║
║           /api/file-assistant            ║
║           /api/health                    ║
╚══════════════════════════════════════════╝
    `);
  });
}

// Only auto-start when run directly (`node server.js`).
// Tests require this file to get `app` without opening a port.
if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}

module.exports = { app, startServer };

