const express = require('express');
const multer = require('multer');
const path = require('path');
const mongoose = require('mongoose');
const { extractFile } = require('../services/fileExtractor');
const { runFileTask } = require('../services/aiFileAssistant');
const { isEngineEnabled, processWithEngine } = require('../services/pythonEngineClient');
const { protect } = require('../middleware/auth');
const UploadedFile = require('../models/UploadedFile');

const router = express.Router();

const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 MB per file
const MAX_FILES_PER_UPLOAD = 3;
const FILE_RETENTION_MS = 24 * 60 * 60 * 1000; // files auto-expire 24h after upload
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx', '.txt', '.csv', '.xlsx']);

// Uploads are persisted per user in MongoDB (see models/UploadedFile.js) instead
// of the old shared in-memory Map. Every route below is JWT-protected and scoped
// strictly to req.user._id, so one account can never see or touch another's files.

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES_PER_UPLOAD
  },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      const error = new Error('Unsupported file type. Use PDF, DOCX, TXT, CSV or XLSX.');
      error.status = 400;
      return callback(error);
    }
    callback(null, true);
  }
});

router.get('/health', (req, res) => {
  res.json({ ok: true, feature: 'MAYA File Assistant' });
});

router.get('/files', protect, async (req, res, next) => {
  try {
    const userId = String(req.user._id);
    // Filter expiresAt explicitly too: the TTL monitor can lag by up to ~60s.
    const docs = await UploadedFile.find({ userId, expiresAt: { $gt: new Date() } })
      .sort({ createdAt: -1 })
      .lean();
    const files = docs.map((doc) => ({
      id: String(doc._id),
      originalName: doc.originalName,
      size: doc.size,
      createdAt: doc.createdAt
    }));
    res.json({ ok: true, files });
  } catch (error) {
    next(error);
  }
});

router.post('/upload', protect, upload.array('files', MAX_FILES_PER_UPLOAD), async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ ok: false, error: 'Choose at least one file first.' });
    }

    const userId = String(req.user._id);
    const uploaded = [];
    for (const file of req.files) {
      let text;
      if (isEngineEnabled()) {
        try {
          text = (await processWithEngine(file)).text;
        } catch (engineError) {
          console.warn(`[MAYA] Python engine failed for ${file.originalname}, using built-in extractor: ${engineError.message}`);
          text = await extractFile(file);
        }
      } else {
        text = await extractFile(file);
      }

      const doc = await UploadedFile.create({
        userId,
        originalName: path.basename(file.originalname),
        size: file.size,
        text,
        expiresAt: new Date(Date.now() + FILE_RETENTION_MS)
      });
      uploaded.push({
        id: String(doc._id),
        originalName: doc.originalName,
        size: doc.size,
        charactersExtracted: text.length
      });
    }

    res.status(201).json({ ok: true, files: uploaded });
  } catch (error) {
    next(error);
  }
});

router.post('/ask', protect, async (req, res, next) => {
  try {
    const instruction = typeof req.body?.instruction === 'string'
      ? req.body.instruction.trim()
      : '';
    const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds : [];

    if (!instruction) {
      return res.status(400).json({ ok: false, error: 'Tell MAYA what task to perform.' });
    }
    if (instruction.length > 2000) {
      return res.status(400).json({ ok: false, error: 'Task instructions must be 2,000 characters or fewer.' });
    }
    if (fileIds.length === 0 || fileIds.length > MAX_FILES_PER_UPLOAD) {
      return res.status(400).json({ ok: false, error: 'Select between 1 and 3 uploaded files.' });
    }

    // Only resolve files owned by the authenticated user. Ids belonging to another
    // user (or malformed ids) are treated as "not found" so ownership is never leaked.
    const userId = String(req.user._id);
    const validIds = fileIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    const docs = validIds.length > 0
      ? await UploadedFile.find({ _id: { $in: validIds }, userId, expiresAt: { $gt: new Date() } }).lean()
      : [];
    const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
    const files = fileIds
      .map((id) => byId.get(String(id)))
      .filter(Boolean)
      .map((doc) => ({ id: String(doc._id), originalName: doc.originalName, text: doc.text }));
    if (files.length !== fileIds.length) {
      return res.status(404).json({ ok: false, error: 'One or more files expired or were not found. Upload them again.' });
    }

    const totalChars = files.reduce((sum, file) => sum + file.text.length, 0);
    if (totalChars > 150_000) {
      return res.status(413).json({ ok: false, error: 'The selected documents contain too much text. Select fewer or smaller files.' });
    }

    const result = await runFileTask({ instruction, files });
    res.json({
      ok: true,
      result,
      files: files.map(({ id, originalName }) => ({ id, originalName }))
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/files/:id', protect, async (req, res, next) => {
  try {
    const userId = String(req.user._id);
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ ok: false, error: 'File not found or already expired.' });
    }
    // Scoped delete: only the owner can remove the file; others get a generic 404.
    const deleted = await UploadedFile.findOneAndDelete({ _id: id, userId });
    if (!deleted) {
      return res.status(404).json({ ok: false, error: 'File not found or already expired.' });
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Route-local error handler. Do not expose stack traces or secrets to the browser.
router.use((error, req, res, next) => {
  console.error('[MAYA File Assistant]', error.message);

  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'Each file must be 8 MB or smaller.'
      : error.code === 'LIMIT_FILE_COUNT'
        ? 'Upload no more than 3 files at once.'
        : 'Upload failed. Check the selected files.';
    return res.status(400).json({ ok: false, error: message });
  }

  const status = Number.isInteger(error.status) ? error.status : 500;
  const aiKeyMissing = !process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY;
  res.status(status).json({
    ok: false,
    error: status === 500 && aiKeyMissing
      ? 'AI API key is not configured on the server.'
      : (error.message || 'Something went wrong while processing your files.')
  });
});

module.exports = router;