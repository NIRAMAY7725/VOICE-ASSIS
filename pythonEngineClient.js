// ============================================
// pythonEngineClient.js — bridge to the Python file engine
// ============================================
// Spawns `python -m maya_engine` as a child process and exchanges one
// JSON request (stdin) for one JSON response (stdout). Uploads are
// passed in-memory as base64 — never written to disk, never executed.
//
// Enable the engine for the existing upload flow with MAYA_FILE_ENGINE=python.
// Override the interpreter with MAYA_PYTHON (defaults to the local venv).
// ============================================

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENGINE_DIR = path.join(__dirname, '..', '..', 'python-engine');
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

function resolvePythonExecutable() {
  if (process.env.MAYA_PYTHON) return process.env.MAYA_PYTHON;
  const venvPython = process.platform === 'win32'
    ? path.join(ENGINE_DIR, '.venv', 'Scripts', 'python.exe')
    : path.join(ENGINE_DIR, '.venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) return venvPython;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function isEngineEnabled() {
  return (process.env.MAYA_FILE_ENGINE || '').toLowerCase() === 'python';
}

// SECURITY: the engine runs third-party parsers, so it must NOT inherit the
// parent's full environment (which holds GEMINI_API_KEY, JWT_SECRET,
// MONGODB_URI, …). Pass only what the interpreter and the optional CLI tools
// actually need. Windows env reads are case-insensitive, so canonical
// upper-case names resolve Path/SystemRoot/Temp correctly.
const ENGINE_ENV_ALLOWLIST = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP',
  'MAYA_TESSERACT_CMD', 'MAYA_PANDOC_CMD', 'MAYA_JQ_CMD', 'MAYA_TAR_CMD',
  'MAYA_PDFINFO_CMD', 'MAYA_PDFTOTEXT_CMD', 'MAYA_PDFFONTS_CMD',
  'MAYA_UNZIP_CMD', 'MAYA_ZCAT_CMD',
];

function buildEngineEnv() {
  const env = { PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
  for (const key of ENGINE_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runEngine(request, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePythonExecutable(), ['-m', 'maya_engine'], {
      cwd: ENGINE_DIR,
      shell: false,
      windowsHide: true,
      env: buildEngineEnv(),
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(response);
    };

    const fail = (message, status) => {
      const error = new Error(message);
      error.status = status;
      child.kill();
      finish(error);
    };

    const timer = setTimeout(() => {
      fail('The Python file engine timed out.', 504);
    }, timeoutMs);

    child.on('error', (err) => {
      finish(Object.assign(
        new Error(`Could not start the Python file engine: ${err.message}. Install it (see python-engine/README.md).`),
        { status: 503 },
      ));
    });

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > MAX_STDOUT_BYTES) fail('Engine response exceeded the size limit.', 500);
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > MAX_STDERR_BYTES) stderr = stderr.slice(-MAX_STDERR_BYTES);
    });

    child.on('close', () => {
      if (stderr.trim()) console.warn('[python-engine]', stderr.trim().split('\n').slice(-3).join(' | '));
      let response;
      try {
        response = JSON.parse(stdout);
      } catch {
        return fail('The Python file engine returned an invalid response.', 502);
      }
      finish(null, response);
    });

    child.stdin.on('error', () => { /* close handler reports the failure */ });
    child.stdin.end(JSON.stringify(request));
  });
}

async function processWithEngine(file, { action = 'process', timeoutMs = DEFAULT_TIMEOUT_MS, options } = {}) {
  const response = await runEngine({
    requestId: crypto.randomUUID(),
    action,
    fileName: path.basename(file.originalname || 'upload'),
    declaredMime: file.mimetype || '',
    contentBase64: file.buffer.toString('base64'),
    ...(options ? { options } : {}),
  }, timeoutMs);

  if (!response || response.ok !== true) {
    const details = response && response.error ? response.error : {};
    const error = new Error(details.message || 'The Python file engine failed to process this file.');
    error.status = Number.isInteger(details.status) ? details.status : 400;
    error.engineCode = details.code || 'PROCESSING_FAILED';
    throw error;
  }
  return response;
}

async function engineHealth() {
  const response = await runEngine({ action: 'health', requestId: crypto.randomUUID() }, 10_000);
  if (!response || response.ok !== true) {
    const error = new Error('The Python file engine health check failed.');
    error.status = 503;
    throw error;
  }
  return response;
}

module.exports = { isEngineEnabled, resolvePythonExecutable, processWithEngine, engineHealth, buildEngineEnv };