// ============================================
// fileProcessing.js — direct API for the Python file engine
// ============================================
// Additive route: /api/file-processing. The existing /api/file-assistant
// flow is untouched unless MAYA_FILE_ENGINE=python is set.
//
//   GET  /health   -> engine version + per-format capabilities
//   POST /process  -> multipart field "files" (1-3 files, 8 MB each)
//                     optional ?action=detect|validate|metadata|process
//   POST /tabular  -> multipart field "file" (CSV/TSV/TXT, 8 MB) plus an
//                     optional "options" field containing JSON:
//                     {operation: profile|filter|sort|aggregate, ...}
//   POST /spreadsheet -> multipart field "file" (XLSX/XLSM, 8 MB) plus an
//                     optional "options" field containing JSON:
//                     {operation: summary|values|inspect, sheet, ...}
//   POST /pdf        -> multipart field "file" (PDF, 8 MB) plus an optional
//                     "options" field containing JSON: {pages: [1,2,...]}
//   POST /ocr        -> multipart field "file" (image or PDF, 8 MB) plus an
//                     optional "options" field containing JSON:
//                     {language, preprocessing, pages, dpi}
//   GET  /convert/formats -> installed Pandoc version + input/output formats
//   POST /convert    -> multipart field "file" (MD/HTML/DOCX/RST/... 8 MB)
//                     plus an "options" field containing JSON:
//                     {outputFormat: "html"|"docx"|"markdown"|..., standalone}
//                     Responds with the converted file as a download.
//   POST /json       -> multipart field "file" (.json, 8 MB) plus an optional
//                     "options" field containing JSON:
//                     {operation: validate|structure|format|query, expression,
//                      indent, sortKeys}
//   POST /archive    -> multipart field "file" (.tar/.tar.gz/.tar.bz2/.tar.xz,
//                     8 MB) plus an optional "options" field containing JSON:
//                     {operation: list|extract, members: ["path/in/archive"]}
//   GET  /utils/status -> availability, version and path of pdfinfo, pdftotext,
//                     pdffonts, unzip, zcat and GNU Tar
//   POST /utils      -> optional multipart field "file" (PDF/ZIP/GZ/tar, 8 MB)
//                     plus an optional "options" field containing JSON:
//                     {operation: status|pdfinfo|pdftotext|pdffonts|unzip|zcat|tar,
//                      members: ["path/in/archive"], layout}
// ============================================

const express = require('express');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const { engineHealth, processWithEngine } = require('../services/pythonEngineClient');
const { protect } = require('../middleware/auth');
const { fileProcessLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const MAX_FILE_SIZE = 8 * 1024 * 1024;
const MAX_FILES_PER_UPLOAD = 3;
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx', '.txt', '.csv', '.xlsx', '.xlsm']);
const ALLOWED_ACTIONS = new Set(['detect', 'validate', 'metadata', 'process']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES_PER_UPLOAD },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      const error = new Error('Unsupported file type. Use PDF, DOCX, TXT, CSV or XLSX.');
      error.status = 400;
      return callback(error);
    }
    callback(null, true);
  },
});

const TABULAR_EXTENSIONS = new Set(['.csv', '.tsv', '.txt']);

const tabularUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (!TABULAR_EXTENSIONS.has(extension)) {
      const error = new Error('Tabular analysis accepts CSV, TSV or TXT files only.');
      error.status = 400;
      return callback(error);
    }
    callback(null, true);
  },
});

const SPREADSHEET_EXTENSIONS = new Set(['.xlsx', '.xlsm']);

const spreadsheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (!SPREADSHEET_EXTENSIONS.has(extension)) {
      const error = new Error('Spreadsheet analysis accepts XLSX or XLSM files only.');
      error.status = 400;
      return callback(error);
    }
    callback(null, true);
  },
});

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (extension !== '.pdf') {
      const error = new Error('PDF analysis accepts PDF files only.');
      error.status = 400;
      return callback(error);
    }
    callback(null, true);
  },
});

const OCR_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.jfif', '.tif', '.tiff', '.bmp', '.gif', '.webp', '.pdf']);

const ocrUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (!OCR_EXTENSIONS.has(extension)) {
      const error = new Error('OCR accepts PNG, JPG, TIFF, BMP, GIF, WEBP or PDF files.');
      error.status = 400;
      return callback(error);
    }
    callback(null, true);
  },
});

const CONVERT_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdown', '.txt', '.html', '.htm', '.docx',
  '.rst', '.tex', '.latex', '.odt', '.epub', '.org', '.textile',
]);

const convertUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (!CONVERT_EXTENSIONS.has(extension)) {
      const error = new Error('Conversion accepts Markdown, TXT, HTML, DOCX, RST, LaTeX, ODT, EPUB, Org or Textile files.');
      error.status = 400;
      return callback(error);
    }
    callback(null, true);
  },
});

const CONVERT_MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.epub': 'application/epub+zip',
  '.tex': 'application/x-tex',
};

const jsonUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (extension !== '.json') {
      const error = new Error('JSON processing accepts .json files only.');
      error.status = 400;
      return callback(error);
    }
    callback(null, true);
  },
});

const ARCHIVE_SUFFIXES = ['.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tbz', '.tar.xz', '.txz'];

const archiveUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (req, file, callback) => {
    const name = (file.originalname || '').toLowerCase();
    if (!ARCHIVE_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
      const error = new Error('Archive processing accepts .tar, .tar.gz, .tar.bz2 or .tar.xz files.');
      error.status = 400;
      return callback(error);
    }
    callback(null, true);
  },
});

// Health stays public (the dashboard polls it), but each check spawns a
// Python process (~1s). Cache the last good result briefly so repeated
// polls don't become a cheap CPU-exhaustion vector.
const HEALTH_CACHE_MS = 60_000;
let healthCache = { at: 0, value: null };

router.get('/health', async (req, res) => {
  try {
    if (healthCache.value && Date.now() - healthCache.at < HEALTH_CACHE_MS) {
      return res.json({ ok: true, feature: 'MAYA File Processing (Python engine)', engine: healthCache.value, cached: true });
    }
    const health = await engineHealth();
    healthCache = { at: Date.now(), value: health };
    res.json({ ok: true, feature: 'MAYA File Processing (Python engine)', engine: health });
  } catch (error) {
    res.status(error.status || 503).json({ ok: false, error: error.message });
  }
});

// All processing routes below require a signed-in user and share a rate
// limit — the engine spawns processes and parses untrusted files.
router.use(protect, fileProcessLimiter);

router.post('/process', upload.array('files', MAX_FILES_PER_UPLOAD), async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ ok: false, error: 'Choose at least one file first.' });
    }

    const action = typeof req.query.action === 'string' ? req.query.action : 'process';
    if (!ALLOWED_ACTIONS.has(action)) {
      return res.status(400).json({ ok: false, error: 'Unknown action. Use detect, validate, metadata or process.' });
    }

    const results = [];
    for (const file of req.files) {
      try {
        const response = await processWithEngine(file, { action });
        results.push({ ok: true, fileName: response.fileName, ...response });
      } catch (error) {
        results.push({
          ok: false,
          fileName: path.basename(file.originalname),
          error: { code: error.engineCode || 'PROCESSING_FAILED', message: error.message },
        });
      }
    }

    const allOk = results.every((result) => result.ok);
    res.status(allOk ? 200 : 207).json({ ok: allOk, results });
  } catch (error) {
    next(error);
  }
});

router.post('/tabular', tabularUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'Choose a CSV or TSV file first (form field "file").' });
    }

    let options = {};
    if (req.body && req.body.options) {
      try {
        options = JSON.parse(req.body.options);
      } catch {
        return res.status(400).json({ ok: false, error: 'The "options" field must contain valid JSON.' });
      }
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        return res.status(400).json({ ok: false, error: 'The "options" field must be a JSON object.' });
      }
    }

    const response = await processWithEngine(req.file, { action: 'tabular', options });
    res.json({
      ok: true,
      fileName: response.fileName,
      detectedType: response.detectedType,
      tabular: response.tabular,
      processingMs: response.processingMs,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/spreadsheet', spreadsheetUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'Choose an XLSX or XLSM file first (form field "file").' });
    }

    let options = {};
    if (req.body && req.body.options) {
      try {
        options = JSON.parse(req.body.options);
      } catch {
        return res.status(400).json({ ok: false, error: 'The "options" field must contain valid JSON.' });
      }
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        return res.status(400).json({ ok: false, error: 'The "options" field must be a JSON object.' });
      }
    }

    const response = await processWithEngine(req.file, { action: 'spreadsheet', options });
    res.json({
      ok: true,
      fileName: response.fileName,
      detectedType: response.detectedType,
      spreadsheet: response.spreadsheet,
      processingMs: response.processingMs,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/pdf', pdfUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'Choose a PDF file first (form field "file").' });
    }

    let options = {};
    if (req.body && req.body.options) {
      try {
        options = JSON.parse(req.body.options);
      } catch {
        return res.status(400).json({ ok: false, error: 'The "options" field must contain valid JSON.' });
      }
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        return res.status(400).json({ ok: false, error: 'The "options" field must be a JSON object.' });
      }
    }

    const response = await processWithEngine(req.file, { action: 'pdf', options });
    res.json({
      ok: true,
      fileName: response.fileName,
      detectedType: response.detectedType,
      pdf: response.pdf,
      processingMs: response.processingMs,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/ocr', ocrUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'Choose an image or PDF file first (form field "file").' });
    }

    let options = {};
    if (req.body && req.body.options) {
      try {
        options = JSON.parse(req.body.options);
      } catch {
        return res.status(400).json({ ok: false, error: 'The "options" field must contain valid JSON.' });
      }
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        return res.status(400).json({ ok: false, error: 'The "options" field must be a JSON object.' });
      }
    }

    // OCR can be slow on scanned pages; allow a longer engine timeout.
    const response = await processWithEngine(req.file, { action: 'ocr', options, timeoutMs: 120_000 });
    res.json({
      ok: true,
      fileName: response.fileName,
      detectedType: response.detectedType,
      ocr: response.ocr,
      processingMs: response.processingMs,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/convert/formats', async (req, res, next) => {
  try {
    const response = await processWithEngine(
      { originalname: 'formats.md', mimetype: 'text/markdown', buffer: Buffer.alloc(0) },
      { action: 'convert', options: { operation: 'formats' } },
    );
    res.json({ ok: true, ...response.conversion });
  } catch (error) {
    next(error);
  }
});

router.post('/convert', convertUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'Choose a document file first (form field "file").' });
    }

    let options = {};
    if (req.body && req.body.options) {
      try {
        options = JSON.parse(req.body.options);
      } catch {
        return res.status(400).json({ ok: false, error: 'The "options" field must contain valid JSON.' });
      }
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        return res.status(400).json({ ok: false, error: 'The "options" field must be a JSON object.' });
      }
    }

    const response = await processWithEngine(req.file, { action: 'convert', options, timeoutMs: 90_000 });
    const conversion = response.conversion;
    const content = await fs.promises.readFile(conversion.outputPath);
    const extension = path.extname(conversion.outputFileName).toLowerCase();
    res.set({
      'Content-Type': CONVERT_MIME_TYPES[extension] || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${conversion.outputFileName}"`,
      'X-Input-Format': conversion.inputFormat,
      'X-Output-Format': conversion.outputFormat,
      'X-Pandoc-Version': conversion.pandocVersion,
      'X-Conversion-Ms': String(response.processingMs),
    });
    res.send(content);
  } catch (error) {
    next(error);
  }
});

router.post('/json', jsonUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'Choose a .json file first (form field "file").' });
    }

    let options = {};
    if (req.body && req.body.options) {
      try {
        options = JSON.parse(req.body.options);
      } catch {
        return res.status(400).json({ ok: false, error: 'The "options" field must contain valid JSON.' });
      }
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        return res.status(400).json({ ok: false, error: 'The "options" field must be a JSON object.' });
      }
    }

    const response = await processWithEngine(req.file, { action: 'json', options });
    res.json({
      ok: true,
      fileName: response.fileName,
      json: response.json,
      processingMs: response.processingMs,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/archive', archiveUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'Choose a tar archive first (form field "file").' });
    }

    let options = {};
    if (req.body && req.body.options) {
      try {
        options = JSON.parse(req.body.options);
      } catch {
        return res.status(400).json({ ok: false, error: 'The "options" field must contain valid JSON.' });
      }
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        return res.status(400).json({ ok: false, error: 'The "options" field must be a JSON object.' });
      }
    }

    const response = await processWithEngine(req.file, { action: 'archive', options, timeoutMs: 60_000 });
    res.json({
      ok: true,
      fileName: response.fileName,
      archive: response.archive,
      processingMs: response.processingMs,
    });
  } catch (error) {
    next(error);
  }
});

const UTIL_SUFFIXES = ['.pdf', '.zip', '.gz', '.gzip', '.z', ...ARCHIVE_SUFFIXES];

const utilsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (req, file, callback) => {
    const name = (file.originalname || '').toLowerCase();
    if (!UTIL_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
      const error = new Error('Utility operations accept PDF, ZIP, GZ or tar archive files.');
      error.status = 400;
      return callback(error);
    }
    callback(null, true);
  },
});

router.get('/utils/status', async (req, res, next) => {
  try {
    const response = await processWithEngine(
      { originalname: 'status.txt', mimetype: 'text/plain', buffer: Buffer.alloc(0) },
      { action: 'utils', options: { operation: 'status' } },
    );
    res.json({ ok: true, ...response.utils });
  } catch (error) {
    next(error);
  }
});

router.post('/utils', utilsUpload.single('file'), async (req, res, next) => {
  try {
    let options = {};
    if (req.body && req.body.options) {
      try {
        options = JSON.parse(req.body.options);
      } catch {
        return res.status(400).json({ ok: false, error: 'The "options" field must contain valid JSON.' });
      }
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        return res.status(400).json({ ok: false, error: 'The "options" field must be a JSON object.' });
      }
    }

    if (!req.file) {
      if (options.operation && options.operation !== 'status') {
        return res.status(400).json({ ok: false, error: 'This operation needs a file (form field "file"). Only "status" works without one.' });
      }
      const response = await processWithEngine(
        { originalname: 'status.txt', mimetype: 'text/plain', buffer: Buffer.alloc(0) },
        { action: 'utils', options: { operation: 'status' } },
      );
      return res.json({ ok: true, utils: response.utils, processingMs: response.processingMs });
    }

    const response = await processWithEngine(req.file, { action: 'utils', options, timeoutMs: 60_000 });
    res.json({
      ok: true,
      fileName: response.fileName,
      utils: response.utils,
      processingMs: response.processingMs,
    });
  } catch (error) {
    next(error);
  }
});

router.use((error, req, res, next) => {
  console.error('[MAYA File Processing]', error.message);

  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'Each file must be 8 MB or smaller.'
      : error.code === 'LIMIT_FILE_COUNT'
        ? 'Upload no more than 3 files at once.'
        : 'Upload failed. Check the selected files.';
    return res.status(400).json({ ok: false, error: message });
  }

  const status = Number.isInteger(error.status) ? error.status : 500;
  res.status(status).json({
    ok: false,
    error: error.message || 'File processing failed.',
    ...(error.engineCode ? { code: error.engineCode } : {}),
  });
});

module.exports = router;