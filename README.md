# MAYA 🎭 — Voice-enabled Personal AI Assistant

MAYA is a full-stack personal AI assistant with chat, persistent short-term
memory, task management, neural voice input/output, and a **File Intelligence
Assistant** that reads, analyzes, converts and extracts from documents using
a dedicated Python engine. The app is security-hardened (JWT-scoped file
routes, XSS-safe rendering, rate-limited AI endpoints) and stores sessions
and uploads in MongoDB with automatic TTL expiry.

> Deep dives: [PROJECT_DETAILS.md](PROJECT_DETAILS.md) (complete project
> guide) and [python-engine/README.md](python-engine/README.md) (engine
> protocol, every analysis module, setup and testing).

## Features

- **Conversation** — Gemini-powered chat (OpenAI-compatible endpoint) with
  **SSE token streaming** (audio starts after the first sentence, not the
  full reply), env-routed fast/heavy models, per-user short-term memory
  persisted in MongoDB (sliding 6-message window + token cap, 30-minute
  session TTL) and multi-action tool handling.
- **Tasks** — create, list, update and complete personal tasks, rendered
  XSS-safe (no `innerHTML`).
- **Voice** — speech input and **neural** Edge-TTS speech output (MP3 via
  HTML5 Audio) with an automatic `speechSynthesis` fallback.
- **File Intelligence** — JWT-protected, per-user uploads persisted in
  MongoDB (24-hour TTL). Upload TXT, CSV, PDF, DOCX, XLSX/XLSM, images,
  JSON, ZIP and tar archives for:
  - text extraction, metadata and validation (content-first detection)
  - Pandas tabular analysis (profile / filter / sort / aggregate)
  - OpenPyXL spreadsheet analysis (summary / values / inspect)
  - pypdf page-wise PDF extraction
  - PyTesseract OCR for images and scanned PDF pages (with preprocessing)
  - Pandoc document conversion (Markdown, HTML, DOCX, …)
  - jq JSON processing (validate / structure / format / query) with a
    pure-Python fallback
  - GNU Tar archive listing and controlled, sandboxed extraction
  - CLI utilities: `pdfinfo`, `pdftotext`, `pdffonts`, `unzip`, `zcat`,
    GNU Tar — auto-detected, with Python fallbacks
- **Auth** — JWT registration/login, bcrypt-hashed passwords, per-IP rate
  limiting on the AI endpoints.
- **Modern frontend** — nine ES modules with a single reactive `Proxy`
  state store (auto-persists the session to localStorage).

## Recent upgrades

- **Latency (Part 1)** — model routing (`FAST_MODEL` for routine turns,
  `HEAVY_MODEL` only for detailed/long-story/complex asks), a 6-message
  history window with a rough token cap, SSE streaming chat
  (`POST /api/agent/chat/stream`) with client-disconnect abort, and
  sentence-chunked TTS so the first sentence is spoken while the rest
  still generates. TTFT/TTFA are logged to the consoles.
- **Security** — XSS-safe task rendering, JWT-protected and per-user file
  routes, and rate limits on chat (30/min), neural TTS (30/min) and file
  analysis (20/min).
- **Persistence** — short-term memory and uploaded files moved from
  in-memory Maps to MongoDB with TTL indexes, so data survives restarts and
  expires automatically (30-minute sessions, 24-hour files).
- **Neural TTS** — replies are spoken with Edge neural voices via
  `POST /api/voice/tts`, falling back to browser speech synthesis on failure.
- **Frontend** — all scripts migrated to ES modules; auth/UI state
  centralized in one reactive Proxy.

## Tech stack

| Layer    | Technology |
|----------|------------|
| Backend  | Node.js, Express 5 (CommonJS), Mongoose 9, Zod 4, Multer, Helmet, JWT, express-rate-limit, node-edge-tts |
| Frontend | Vanilla JS ES modules + CSS (served by the backend), reactive Proxy state, Aurora Teal/Violet theme |
| Engine   | Python 3.10+ — pypdf, python-docx, openpyxl, pandas, pytesseract, pypdfium2, Pillow |
| Database | MongoDB (local or Atlas) |
| AI       | Gemini via OpenAI-compatible API (`AI_PROVIDER=gemini` by default) |

## Repository layout

```
MAYA🎭/
├── backend/               # Express API + serves the frontend
│   ├── server.js          # entry point (PORT from .env, default 3000)
│   ├── routes/            # agent, tasks, voice, fileAssistant, fileProcessing
│   ├── services/          # AI provider, memory, voice, pythonEngineClient, fileExtractor
│   ├── middleware/        # JWT auth (protect) + AI rate limiters
│   ├── models/            # User, Task, Memory, UploadedFile (TTL-indexed)
│   └── .env.example       # copy to .env and fill in (never commit .env)
├── frontend/              # static SPA — 7 ES modules (chat, tasks, files, voice, brain)
├── python-engine/         # maya_engine package — stdin/stdout JSON protocol
│   ├── maya_engine/       # 17 modules: pipeline, detectors, analysis modules
│   ├── tests/             # 325 unit + end-to-end CLI tests
│   └── requirements.txt
├── PROJECT_DETAILS.md     # complete project guide
└── package.json           # root scripts delegate to backend
```

## Quick start

### 1. Prerequisites

- Node.js 18+ and npm
- Python 3.10+
- MongoDB running locally (`mongodb://localhost:27017`) or an Atlas URI
- A Gemini API key

### 2. Backend

```bash
cd backend
npm install
copy .env.example .env        # Windows (cp on macOS/Linux)
```

Edit `backend/.env` and set at least:

```
MONGODB_URI=mongodb://localhost:27017/maya-ai
GEMINI_API_KEY=your-key
JWT_SECRET=a-random-string-at-least-32-chars
PORT=3000
```

### 3. Python file engine

```bash
cd python-engine
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt   # Windows
# macOS/Linux: .venv/bin/python -m pip install -r requirements.txt
```

The backend finds `.venv` automatically. The engine works out of the box
for TXT/CSV/PDF/DOCX/XLSX/JSON/ZIP/tar; optional binaries unlock more
(see below).

### 4. Run

```bash
# from the project root:
npm run dev        # nodemon (auto-restart)
# or:
npm start          # plain node
```

Open **http://localhost:3000**, register an account, and start chatting.

## Optional binaries (Windows)

All are auto-detected; nothing is required for core features. Each has a
`MAYA_*_CMD` override in `backend/.env` (see `.env.example`).

| Capability | Binary | Install | Without it |
|------------|--------|---------|------------|
| OCR | Tesseract | `winget install --id UB-Mannheim.TesseractOCR` | Text PDFs still extract; images report missing dependency |
| Conversion | Pandoc | `winget install --id JohnMacFarlane.Pandoc` | `/convert` returns an install hint |
| Full jq filters | jq | `winget install --id jqlang.jq` | Validate/structure/format/dot-path queries still work |
| pdfinfo / pdffonts | Poppler | `winget install --id oschwartz10612.Poppler` | pdfinfo falls back to pypdf; pdffonts needs the binary |
| unzip / zcat / GNU tar / pdftotext | Git for Windows | already bundled | Python fallbacks cover all but pdffonts |

Check what's detected:

```bash
curl http://localhost:3000/api/file-processing/health
curl http://localhost:3000/api/file-processing/utils/status
```

Restart the backend after installing binaries or editing `.env`.

## API overview

Auth: `POST /api/agent/register`, `POST /api/agent/login` → JWT.
Chat: `POST /api/agent/chat` (JWT, 30 req/min per IP) and
`POST /api/agent/chat/stream` (JWT, same limiter) — the streaming variant
responds with Server-Sent Events: `token` (incremental text), `done`
(`{reply, toolResults}`), `error`, plus a `: heartbeat` comment every 15 s.
Both accept `voiceMode: true` for short, spoken-style replies. Tasks:
`/api/tasks` (JWT). Voice: `POST /api/voice/tts` (neural MP3, JWT,
30 req/min), `GET /api/voice/voices`, `POST /api/voice/process` (JWT).

**File assistant (JWT required, per-user):** `POST /api/file-assistant/upload`
(1–3 files, 8 MB each), `GET /api/file-assistant/files`,
`POST /api/file-assistant/ask` (20 req/min),
`DELETE /api/file-assistant/files/:id`. Uploads persist in MongoDB for
24 hours (TTL index) and are only visible to their owner. Set
`MAYA_FILE_ENGINE=python` in `.env` to route uploads through the engine
(falls back to the built-in extractor on any failure).

**File processing (engine-powered, additive):**

| Route | Purpose |
|-------|---------|
| `GET /api/file-processing/health` | Engine version + capabilities |
| `POST /process` | Detect / validate / metadata / extract (1–3 files) |
| `POST /tabular` | Pandas CSV/TSV analysis |
| `POST /spreadsheet` | OpenPyXL XLSX/XLSM analysis |
| `POST /pdf` | Page-wise PDF extraction |
| `POST /ocr` | Images + scanned PDF pages |
| `GET /convert/formats`, `POST /convert` | Pandoc conversion (file download) |
| `POST /json` | JSON validate / structure / format / query |
| `POST /archive` | Tar listing + controlled extraction |
| `GET /utils/status`, `POST /utils` | CLI utility detection + operations |

All accept multipart uploads (8 MB cap) with an optional `options` JSON
field. Full request/response shapes, error codes and curl examples:
[python-engine/README.md](python-engine/README.md).

## Tests

Python engine (325 tests):

```bash
cd python-engine
.venv/Scripts/python.exe -m unittest discover -s tests
```

Covers validation, detection, every analysis module, mocked-binary paths,
security regressions (path traversal, option injection, jq env leak), and
real-binary tests that auto-activate when the tools are installed.

Backend full-system health check (MongoDB, bcrypt, JWT, AI brain, tool
calling, memory, tasks) — run against your local `.env`:

```bash
cd backend
node test-all.js
```

Backend regression suites (Stage-1 security + Part-1 latency; AI streams
are stubbed, so no tokens are spent; local MongoDB must be running):

```bash
cd backend
npm test
```

Frontend unit tests (sentence chunker + SSE client parser; no browser or
server needed) — run from the project root:

```bash
node --test frontend/tests/*.test.mjs
```

## Latency tuning

Set in `backend/.env` (see `.env.example` for all options):

| Var | Default | Effect |
|-----|---------|--------|
| `FAST_MODEL` | `gemini-3.1-flash-lite` (Gemini) / `gpt-4o-mini` (OpenAI) | Model for routine chat turns |
| `HEAVY_MODEL` | `gemini-3-flash-preview` / `gpt-4o` | Only for "detailed"-style asks, long story writing, complex explanations |
| `MEMORY_WINDOW_MESSAGES` | `6` | History messages sent to the model (oldest dropped first) |
| `MEMORY_TOKEN_CAP` | `1500` | Rough token budget for history (~4 chars/token); system prompt always kept |
| `VOICE_MAX_TOKENS` | `512` | Token budget for voice-mode replies (short conversational prompt) |

Measured on this machine (browser, logged-in): first chat token ~1.4 s,
first sentence audio ~2.9 s — audio begins while the reply is still
generating. Upstream LLM calls reuse pooled keep-alive connections
(Node's undici), history/context loads run in parallel, and a client
disconnect aborts the upstream generation so no tokens are wasted.

## Security notes

Application layer:

- Task rendering is **XSS-safe** — user/AI-provided strings are inserted
  with `textContent`, never `innerHTML`.
- File-assistant routes require a JWT and every query is scoped to the
  authenticated user (other users' files return 404).
- AI endpoints are rate-limited per IP: chat 30/min, neural TTS 30/min,
  file analysis 20/min (standard `RateLimit-*` headers, JSON 429 body).
- Session memory expires after 30 minutes of inactivity; uploaded files
  are auto-deleted after 24 hours (MongoDB TTL indexes).

Engine layer:

- Uploaded files are **never executed** — only read as bytes.
- Archive extraction is sandboxed: member-name validation, symlink
  refusal, size/count caps, timeouts, post-extraction containment checks.
- All subprocesses run with `shell=False` (no shell injection); the jq
  subprocess gets a sanitized environment so API keys never leak.
- 8 MB upload cap, 120k extracted characters, page/row/depth limits
  throughout.

`backend/.env` holds live secrets — never commit or share it; use
`.env.example` as the template.

## License

MIT (backend package metadata).