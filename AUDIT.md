# MAYA — Full Project Audit & Improvement Plan

**Date:** 2026-11-08 · **Scope:** entire repository (backend, frontend, Python engine integration, dependencies, tests)
**Method:** every backend source file and all 7 frontend modules + 3 CSS files read fully; critical findings re-verified directly against code by the lead; `npm audit` run on both package roots; 325 Python engine tests re-executed; live endpoint latency measured. No application files were modified during this audit.

Priority scale: **Critical** (exploitable now / data loss) · **High** (serious risk or broken core flow) · **Medium** (real weakness, bounded impact) · **Low** (polish / defense-in-depth).

Finding IDs: `BE-*` = backend, `FE-*` = frontend, `DEP-*` = dependencies/environment, `TST-*` = testing.

---

## Executive summary

The recent security upgrade (JWT-scoped file assistant, rate limiters, TTL persistence, XSS-safe rendering, ES modules) is solid and verified. However, the audit found **one Critical exposure** — the entire Python-engine router is unauthenticated and unthrottled — plus several High-severity gaps (open TTS relay, unlimited login attempts, hardcoded JWT fallback secret, unvalidated AI tool arguments, 10-minute default AI timeouts). The frontend has real reliability bugs (mic-stop auto-send race, no fetch timeouts, stale TTS playback) and the product lacks the voice polish, memory intelligence, dashboard UI, and test coverage described in Prompts 2–6.

**Top 5 to fix first:** BE-S1 (open engine router), BE-S2/S3 (open TTS + unlimited login), BE-S4 (JWT fallback secret), BE-S5 (tool-arg injection), BE-B1 (no AI timeout).

| Priority | Count (approx.) |
|----------|-----------------|
| Critical | 1 |
| High | 10 |
| Medium | ~35 |
| Low | ~35 |

---

## 1. Security findings

### Critical

**BE-S1 — `/api/file-processing/*` completely unauthenticated and unthrottled**
- **Where:** `backend/routes/fileProcessing.js` (all 12 routes; mounted at `server.js:81`). Verified: no `protect` import, no limiter.
- **Current:** anyone can call OCR (120 s engine timeout), Pandoc conversion, archive **extraction**, and `/utils` (unzip/tar/pdftotext). Every request spawns a fresh Python process (see BE-P1).
- **Why:** remote process-exhaustion DoS and free use of server resources; extraction endpoints exposed without ownership.
- **Fix:** `router.use(protect)` + a dedicated limiter in `server.js` (mirror `fileAskLimiter`); keep `/health` public but cached.
- **Priority:** Critical.

### High

**BE-S2 — `/api/voice/tts` is an open Edge-TTS relay**
- **Where:** `backend/routes/voiceRoutes.js:43–79`.
- **Current:** only per-IP 30/min limit; no auth. Distributed IPs bypass it.
- **Fix:** add `protect` (frontend already holds a JWT; add the header in `voice.js`). `/voices` may stay public (static list).
- **Priority:** High.

**BE-S3 — No rate limit on login/register**
- **Where:** `backend/routes/agentRoutes.js:46,95`; `server.js:73–75` limits only chat/tts/file-ask.
- **Why:** unlimited password brute force and mass account creation.
- **Fix:** `authLimiter` (~10/min/IP) on both endpoints.
- **Priority:** High.

**BE-S4 — Hardcoded JWT fallback secret**
- **Where:** `backend/middleware/auth.js:21–24` (verified).
- **Current:** unset `JWT_SECRET` → published default `'maya-dev-secret-change-in-production'`; anyone can forge tokens.
- **Fix:** throw at startup when missing in production; warn-only in dev.
- **Priority:** High.

**BE-S5 — AI tool arguments reach MongoDB unvalidated**
- **Where:** `backend/agents/mainAgent.js:40–44` (verified) → `taskService.updateTask` (`taskService.js:86–90`) → `findOneAndUpdate`.
- **Current:** model-produced JSON is spread into the update; a prompt-injected reply can emit `{"userId":"<other id>"}` (ownership reassignment) or `$`-operators. `getTasks` filters (`taskService.js:51–58`) likewise accept raw values. REST paths are safe (Zod strips unknown keys); the tool path has no schema.
- **Fix:** validate tool args with the existing Zod task schemas (share them from a schema module) before calling services.
- **Priority:** High.

**BE-B1 — No timeout on AI calls**
- **Where:** `backend/services/aiService.js:35–38,45–47` (verified).
- **Current:** OpenAI SDK defaults = **10 min timeout + 2 retries**; with 3 fallback models × up to 6 calls/turn, one chat can hang for many minutes holding sockets and limiter slots.
- **Fix:** `new OpenAI({ …, timeout: 30_000, maxRetries: 1 })`.
- **Priority:** High.

**FE-1.1 — Mic-stop race auto-sends partial transcript**
- **Where:** `frontend/js/voice.js:232–240,264–269` (verified) + `assistant.js:400–430`.
- **Current:** `stopListening()` → `recognition.stop()` fires `onend`, which **resolves** the pending promise; the awaiting `handleMicButton` then sends whatever was heard — even after the overlay closed.
- **Fix:** cancellation flag/generation counter; deliberate stop rejects with a silent `cancelled` error.
- **Priority:** High.

**FE-1.2 — No fetch timeout/abort anywhere in the frontend**
- **Where:** `assistant.js:94`, `voice.js:334`, `file-assistant.js:176`. Verified: zero `AbortController` usage.
- **Why:** a hung server leaves `isProcessing=true` and the typing indicator forever; the app silently locks.
- **Fix:** shared API client with `AbortController` + timeouts (30 s chat, 20 s TTS).
- **Priority:** High.

**FE-1.3 — Stopping TTS mid-fetch doesn't prevent playback**
- **Where:** `frontend/js/voice.js:333–362,406–411`.
- **Current:** `stopSpeaking()` releases only the current audio; an in-flight `/tts` fetch still plays when it resolves.
- **Fix:** abort the fetch + generation token checked before `audio.play()`.
- **Priority:** High.

**DEP-1 — Root `xlsx` dependency: High advisory, no npm fix, unused**
- **Where:** root `package.json` (`xlsx@^0.18.5`); verified via `npm audit`: GHSA-4r6h-8v6p-xvw6 (prototype pollution) + GHSA-5pgg-2g8v-p4x9 (ReDoS), `fixAvailable: false`.
- **Current:** root scripts only delegate to `backend/`; nothing imports root `node_modules`. Backend uses `read-excel-file`/OpenPyXL instead.
- **Fix:** remove all root dependencies (keep the delegating scripts), delete root `node_modules` + lockfile.
- **Priority:** High.

### Medium

**BE-S6 — SSML injection via unvalidated TTS params.** `voiceRoutes.js:25–30` accepts arbitrary `voice/rate/pitch` strings; node-edge-tts interpolates them raw into SSML (verified in `dist/edge-tts.js:220–221`). Fix: whitelist voice against `CURATED_NEURAL_VOICES`; regex `rate /^[+-]\d{1,3}%$/`, `pitch /^[+-]\d{1,3}Hz$/`.

**BE-S7 — CORS `*` + CSP disabled.** `server.js:43–53` (verified). Token-in-header auth limits CSRF, but any site can script the API and XSS has no CSP containment. Fix: env-driven origin allowlist (`CORS_ORIGINS`); enable a basic CSP in production.

**BE-S8 — Extension-only upload validation; parsers in-process.** `fileAssistant.js:28–36`, `fileProcessing.js:57–65`; `fileExtractor.js` runs pdf-parse/mammoth/read-excel-file with no timeout — a crafted 8 MB zip-based file can spike CPU/memory. Fix: magic-byte sniff (`%PDF`, `PK`), extraction timeout, prefer the isolated engine for hostile formats.

**BE-S9 — Route error handlers leak internals.** `taskRoutes.js:66,85,98,119,132`, `fileAssistant.js:184–191`, `fileProcessing.js:540–545` return raw `error.message` on 500 (engine messages can contain local paths). The global handler hides details correctly; these bypass it. Fix: log server-side, generic 5xx messages, curated 4xx.

**BE-S10 — Full parent environment passed to Python child.** `pythonEngineClient.js:41` (verified): `env: { ...process.env, … }` hands `GEMINI_API_KEY`, `JWT_SECRET`, `MONGODB_URI` to every engine process running third-party parsers. Fix: minimal allowlist (`PATH`, `SYSTEMROOT`, `TEMP`, `MAYA_*`, `PYTHONIOENCODING`, `PYTHONDONTWRITEBYTECODE`).

**BE-S11 — Unescaped `$regex` from user input (ReDoS).** `taskService.js:58`, `memoryService.js:110,145` (verified). `(a+)+$`-style input can hang the DB; invalid regex → 500 with leaked message. Express 5's `simple` query parser blocks classic GET NoSQL injection, but these paths remain. Fix: escape metacharacters + length cap (or text index).

**BE-S12 — Weak password policy.** `models/User.js:41`, `agentRoutes.js:28`: min 6, no max; bcrypt silently truncates >72 bytes. Fix: min 8–10, `.max(72)`.

**BE-V2 — `/api/voice/process` bypasses the chat limiter.** `server.js:73–75` limits only `/api/agent/chat`, but `voiceRoutes.js:82–90` runs the identical `processMessage` pipeline. Fix: mount `chatLimiter` there too.

**FE-3.2 — No 401 recovery / session validation.** `assistant.js:754–758` trusts localStorage blindly; 401s surface as generic bubbles leaving a dead chat screen. Fix: on any 401 clear `state.token/user` + `showAuth()`; optional boot-time verification.

**FE-4.1 — Mic permission handling reactive-only.** `voice.js:242–257` maps only 3 error codes; no pre-check or recovery guidance. Fix: `navigator.permissions.query({name:'microphone'})` + specific messages/retry.

### Low

- **BE-S13** — 7-day JWTs, no revocation (`auth.js:83`). Shorten via existing `JWT_EXPIRES_IN`.
- **BE-S14** — `/convert` reads engine-supplied path without containment check (`fileProcessing.js:387`); defense-in-depth.
- **BE-S15** — `mainAgent.js:127` logs full tool args (user facts); redact/truncate in production. No passwords/tokens/keys are logged anywhere (verified).

---

## 2. Reliability bugs

### Backend

| ID | Where | Current → Fix | Priority |
|----|-------|---------------|----------|
| BE-B2 | `mainAgent.js:125` | `JSON.parse` of tool args outside try/catch aborts the whole turn → move inside per-tool try | Medium |
| BE-B3 | `voiceRoutes.js:57–77` | Mid-stream TTS error never ends response; client disconnect doesn't stop loop; backpressure ignored → `res.on('close')` abort, `res.destroy()`, pipeline semantics | Medium |
| BE-B4 | `taskService.js:61–63` | Unbounded task listing → `.limit(200)` + pagination | Medium |
| BE-B5 | `memoryService.js:51–65`, `Memory.js:69` | Upsert on non-unique index can duplicate session docs under concurrency → unique partial index + E11000 retry | Low |
| BE-B6 | `taskService.js:31,97,119` | Verify-after-write doubles every task query → drop read-backs | Low |
| BE-B7 | `fileAssistant.js:74` | Engine-path text stored unbounded (built-in clips at 120k) → apply same clip | Low |
| BE-B9 | `agentRoutes.js:52–65` | Concurrent identical registration → 500 instead of 400 → catch E11000 | Low |
| BE-B10 | `server.js` | No graceful shutdown; children orphaned on restart → SIGINT/SIGTERM handler | Low |
| BE-B12 | `agentRoutes.js:38`, `Task.js:74`, `test-all.js:40–118` | `sessionId` unbounded; missing `{userId,createdAt}` task index; health check leaves test data on mid-run failure | Low |

### Frontend

| ID | Where | Current → Fix | Priority |
|----|-------|---------------|----------|
| FE-1.4 | `voice.js:348`, `assistant.js:744–747` | Second `speak()` lets old audio continue during new fetch; last-resolved wins → `stopSpeaking()` at top of `speak()` | Medium |
| FE-1.5 | `voice.js:209–211,259` | `stop()`→`start()` before `onend` throws `InvalidStateError` → `abort()` + await `onend` | Medium |
| FE-1.6 | `assistant.js:207–214` | Logout leaves mic/audio/overlays running; no `pagehide` cleanup → full teardown | Medium |
| FE-1.7 | `immersive.js:136–146` | `visibilitychange` restarts rAF despite reduced-motion → guard | Low |
| FE-1.8 | `voice.js:137–139` vs `assistant.js:749–751` | `onvoiceschanged` handler collision → `addEventListener` both | Low |
| FE-1.9 | `assistant.js:361–365,450–451`, `voice.js:286–288` | Dead branches; regex order makes markdown-link strip unreachable → delete/reorder | Low |
| FE-1.10 | `voice.js:79–80` | Corrupt storage → NaN rate/pitch → clamp with fallback | Low |
| FE-1.11 | `brain.js:284–292,35–44,193–201` | 0×0 resize → NaN aspect; double-open injects two Three.js tags; TextureLoader no onError → guard/cache/fallback | Low |
| FE-1.12 | `assistant.js:514–521,564–577` | Task toggle double-click race → disable until PUT resolves | Low |
| FE-1.13 | `file-assistant.js:392–394,410–423` | Failed task leaves Read-aloud/Download disabled → restore from `lastResult` in `finally` | Low |
| FE-1.14 | `voice.js:92–94`, `assistant.js:282–285` | `audioCtx.resume()` rejection escapes; core state inferred from status substrings → `.catch`, explicit state | Low |

---

## 3. Duplication & code quality

| ID | Where | Current → Fix | Priority |
|----|-------|---------------|----------|
| FE-2.1 | `assistant.js:8–31`, `voice.js:13–29`, `appearance.js:18–41`, `file-assistant.js:167–172` | safeStorage ×4 → one `js/utils/storage.js` | Medium |
| FE-2.2 | `assistant.js:82–110` vs `file-assistant.js:164–199` | Two fetch wrappers, divergent semantics → single client (token + optional `ok` check + abort/timeout) | Medium |
| FE-2.3 | `file-assistant.js:429–454` | Reimplements browser-only TTS (reads raw Markdown; `cancel()` kills chat audio) → reuse `voiceService.speak()` with chunking | Medium |
| FE-2.4 | 4 modules | `setStatus` ×2, `$` ×4, `reduceMotion` ×2 → shared utils | Low |
| BE-B8 | `fileProcessing.js` | 8 near-identical multer configs + 8 options-parse blocks + duplicated error handlers → `makeUpload()` factory + shared `parseOptions()` | Low |
| BE-B11 | `memoryService.js:71,106,119,129`, `taskTools.js:193–196`, `voiceService.js:112–120` | Exported-but-uncalled functions (`clearShortTermMemory`, `searchLongTermMemories`, `deleteLongTermMemory`, `saveKnowledge`), stale comments, ignored param → wire into memory routes (Prompt 4) or remove | Low |
| FE-6.1 | `dashboard.js` (loaded at `index.html:339`) | Entirely dead — never imported; `getStats` counts a status the UI never sets → wire into task panel or drop tag | Medium |
| FE-6.3 | `file-assistant.js:530–536,3,7` | Unused `window.MAYAFileAssistant` bridge; stale path comments → use or remove; fix comments | Low |
| DEP-2 | root `package.json` | Legacy duplicate deps (dotenv/mammoth/multer/openai/pdf-parse/xlsx) unused since scripts delegate to backend → remove with DEP-1 | High (with DEP-1) |

---

## 4. Feature gaps (mapped to Prompts 2–4)

### Voice (Prompt 2)

| ID | Gap | Where | Priority |
|----|-----|-------|----------|
| FE-4.2 | STT is browser utterance-batched, **not true streaming**; `continuous=false`, no auto-relisten after reply | `voice.js:145–149,217–240`, `assistant.js:335–338` | Medium |
| FE-4.3 | No pause/resume (stop-and-discard only) | `voice.js:406–411` | Medium |
| FE-4.4 | No volume control (`volume=1.0` hardcoded, no slider) | `voice.js:373` | Medium |
| FE-4.5 | Waveform/EQ bars are pure CSS keyframes — no AnalyserNode, not audio-driven | `index.html:229–233`, `style.css:1058–1079` | Medium |
| FE-4.6 | Interrupt/barge-in incomplete (= FE-1.1/1.3 aggregate) | voice.js + assistant.js | High |
| FE-4.7 | Transcript sync minimal: one line per turn, no history, error styled as assistant | `assistant.js:368–373` | Low |
| FE-4.8 | No mic/audio release on logout/pagehide; chime AudioContext lives forever | see FE-1.6 | Low |
| BE-V1 | Edge-TTS: library-default 10 s timeout, no retry, no fallback voice on retirement → 500 | `voiceService.js:100–106`, `voiceRoutes.js:71–77` | Medium |

**Honesty note (per Prompt 2):** `webkitSpeechRecognition` gives interim *text* but is utterance-scoped (Chrome relays audio to a cloud service; no raw stream control). True streaming STT would require MediaRecorder/WebSocket to a streaming backend — a deliberate future decision, not something to fake.

### Memory (Prompt 4)

| ID | Gap | Where | Priority |
|----|-----|-------|----------|
| BE-M1 | No user-facing memory management: no memory routes; users can't list/delete long-term memories or clear sessions despite implemented service functions | `memoryService.js:71–73,119–121` | Medium |
| BE-M2 | No summarization, dedupe, or relevance search; 10 newest long-term + 5 knowledge injected verbatim; `saveLongTermMemory` uncapped → collection grows forever, old facts invisible | `memoryService.js:81–89,159–179` | Medium |
| BE-M3 | Knowledge tier unreachable (`saveKnowledge` has no tool/endpoint) | `memoryService.js` | Low |
| BE-M4 | Session isolation correct (userId+sessionId) but clients can mint unlimited sessionIds; default `session-${userId}` merges devices | `mainAgent.js:79` | Low |
| — | Missing categories: project memory, task memory, conversation summaries (Prompt 4) | model enum currently `short-term/long-term/task/knowledge` | Medium |

### UI/UX (Prompt 3)

| ID | Gap | Where | Priority |
|----|-----|-------|----------|
| FE-5.1 | No sidebar/home/memory navigation — header button row only; no dashboard | `index.html:99–208` | Medium |
| FE-5.2 | Settings modal: no `aria-modal`, focus trap, Escape, or focus restore | `index.html:249`, `assistant.js:601–639` | Medium |
| FE-5.3 | Warmth presets are non-focusable divs | `index.html:261–276` | Medium |
| FE-5.4 | Voice overlay: focus stays behind it; no Escape exit | `assistant.js:375–387` | Medium |
| FE-5.5 | Contrast: `--text-muted #64748b` ≈ 4.2:1 (below AA); boot log ≈ 2.7:1; pervasive 8–10px HUD text | `style.css:15,208,482,591,831` (verified) | Medium |
| FE-5.6 | Messages silently dropped while busy/TTS playing; send never disabled | `assistant.js:292` | Medium |
| FE-5.7 | iOS focus-zoom (13px inputs) | `style.css:387,820` | Low |
| FE-5.8 | Mobile header crowding; voice overlay clipping on short screens | `index.html:125–138`, `style.css:490–495,986,1392` | Low |
| FE-5.9 | Always-on ambient motion at idle (battery); Signal/Empathy/Focus meters are random walks presented as live stats | `style.css` animations, `immersive.js:122,155–180` | Low |
| FE-5.10 | Single-line input with dead Shift+Enter check; no Retry on errors; "ready" shown offline; missing `aria-pressed` | `index.html:182–188`, `assistant.js:662,339–346` | Low |
| FE-3.1 | Uploaded-file list never fetched — refresh loses UI files that still exist server-side (verified: no GET call) | `file-assistant.js` vs `fileAssistant.js:43–60` | Medium |
| FE-3.3 | Chat `maxlength` not enforced client-side (backend max 2000) | `index.html:182–188` | Low |
| FE-3.4 | `sessionId` never sent (verified: body is `{message}` only) | `assistant.js:318` | Low |
| FE-3.5 | Cross-user stale file list after logout (closure never reset) | `file-assistant.js:39` | Low |
| FE-3.6 | Task button no-op inside File Intelligence (`#task-panel` hidden `!important`) | `assistant.js:443–460`, `file-assistant.css:31–32` | Low |
| FE-3.7 | No upload progress for up to 24 MB | `file-assistant.js:306–310` | Low |
| FE-6.2 | No chat history persistence (vanishes on refresh); no history endpoint | `assistant.js:156–162,211` | Medium |

---

## 5. Performance & scalability

| ID | Where | Current → Fix | Priority |
|----|-------|---------------|----------|
| BE-P1 | `pythonEngineClient.js:35–42,120–128` | Fresh interpreter per request; no concurrency cap; `/health` spawns on **every** call. **Measured: ~1.1 s per health call, warm or cold.** With BE-S1 open = trivial DoS → auth+limiter, semaphore (2–4), health cache 30–60 s; persistent worker later | Medium (Critical combined with BE-S1) |
| BE-E2 | `pythonEngineClient.js:56–65` | Timeout kill = SIGTERM only, no escalation; children untracked → SIGKILL after grace, live-child Set, cleanup on exit | Low |
| BE-E3 | `pythonEngineClient.js:74–76` | Stdout cap counts UTF-16 chars, not bytes (multibyte can exceed 8 MB ~3×) → Buffer + byteLength | Low |
| BE-P2 | `rateLimit.js:19–30` | In-memory store: per-process, resets on restart; no `trust proxy` → document; Redis store only if scaled | Low |
| BE-P3 | `server.js:56` | 10 MB JSON cap vs 2000-char messages → ~64 kb; chat responses non-streaming (SSE would improve perceived latency — enhancement, not defect) | Low |

**Measured live latency (this audit):** frontend `/` 8.7 ms (15.7 KB) · `/api/file-assistant/health` 2.5 ms · `/api/voice/voices` 4.2 ms · `/api/file-processing/health` **~1.1 s every call**.

**Engine integration (verified working):** `spawn(python, ['-m','maya_engine'], {shell:false})`; base64 JSON via stdin/stdout; files never touch disk or execute; 30 s default timeout (OCR 120 s, convert 90 s, archive/utils 60 s); stdout 8 MB / stderr 64 KB caps; upload flow falls back to built-in extractor on any engine failure; engine temp dirs TTL-cleaned.

---

## 6. Testing & quality gaps (Prompt 6)

| ID | Gap | Priority |
|----|-----|----------|
| TST-1 | No backend integration test suite — only `test-all.js` (7-layer health check, creates real users, cleans up only on success path). No CI-style tests for 401/429/404 isolation, upload limits, AI failure, TTS fallback | High |
| TST-2 | Zero frontend tests (state Proxy, XSS rendering, voice fallback, API client all untested) | Medium |
| TST-3 | No test-report generation | Medium |
| TST-4 | Python engine: **325 tests re-run this audit — all pass, 8 skipped** (optional binaries Tesseract/Pandoc/jq not currently detected: capabilities `ocr:false, convert:false, jq:false`). Preserve as-is | — (healthy) |

---

## 7. Dependencies & environment

- **Backend `npm audit --omit=dev`: 0 vulnerabilities** (info/low/moderate/high/critical all 0).
- **Root `npm audit`: 1 High** — `xlsx` (DEP-1), unused legacy (DEP-2).
- **DEP-3 — No git repository.** `.gitignore` exists and is correct (`.env`, `node_modules`, logs), but there is no version-control safety net before a large redesign. **Recommend `git init` + baseline commit as Stage 0.** Priority: Medium.
- `.env.example` is complete and secret-free (verified); live `.env` never read/printed during this audit. `JWT_EXPIRES_IN=7d` default (see BE-S13).
- Dev server has no process supervision (it stopped between sessions); acceptable for dev, note for deployment.

---

## 8. Working well — preserve

**Backend:** JWT-scoped file assistant with generic 404s + ObjectId validation · UploadedFile 24 h TTL with explicit `expiresAt` filter · atomic `$push/$slice -10` memory window with refreshed TTL + compound index · dual-shape JSON rate-limit messages · Zod on all REST auth/chat/task paths · bcrypt `select:false` + pre-save hook · identical generic login errors · `router.use(protect)` on tasks with ownership in every query · engine bridge `shell:false` + base64 transport + timeouts + caps + extractor fallback · Multer limits with friendly error mapping · 120k clip + NUL stripping · anti prompt-injection file-analysis system prompt · Express 5 async error forwarding · production-safe global error handler · tool-loop cap of 5.

**Frontend:** reactive Proxy state with auto-persist + `coreState` reflection · XSS-safe rendering everywhere (`addMessage`, `loadTasks`, file list) · neural TTS with cleanup, 2000-char routing, object-URL revocation, autoplay fallback · keyboard-accessible task checkboxes · loading/empty/error states for tasks + files · Bearer auth on all file routes (contracts verified against backend schemas) · reduced-motion support + DPR cap + visibility pause · brain static-image fallback + Escape + rAF stop · logo upload hardening (pattern + 512 KB cap) · file workspace focus management + drag-and-drop · live regions (`role=log/status`).

---

## 9. Staged implementation plan

Order rationale: **secure → stabilize → test-net → de-duplicate → features (voice → memory → UI) → final QA.** The UI redesign comes last so it can integrate the finished voice and memory systems instead of being rebuilt twice. Every stage ends with: modified-file list, explanation, executed tests, error report, and an **approval gate** before the next stage.

### Stage 0 — Safety net (small) ✅ DONE
`git init` + baseline commit (existing `.gitignore` keeps `.env` out); record baseline test results. No app code changes. Baseline commit: `14922c3`.

### Stage 1 — Critical & High security fixes (Prompt 5 core) ✅ DONE
BE-S1 (protect + limiter on file-processing, cached public health), BE-S2 (JWT on TTS + frontend header), BE-S3 (auth limiter), BE-S4 (fail-fast JWT secret), BE-S5 (Zod-validate AI tool args), BE-S6 (SSML param validation), BE-S10 (minimal child env), BE-V2 (limit voice/process), BE-B1 (AI timeouts). Introduce a minimal `node:test` + supertest harness and add a **regression test per fix**.
*Files:* `server.js`, `middleware/auth.js`, `middleware/rateLimit.js`, `routes/fileProcessing.js`, `routes/voiceRoutes.js`, `routes/agentRoutes.js`, `agents/mainAgent.js`, task schema module, `services/aiService.js`, `services/pythonEngineClient.js`, `frontend/js/voice.js`, new `backend/tests/`.
*Verify:* regression suite + `test-all.js` + live 401/429 checks + browser smoke.
*Result:* 38/38 regression tests pass (`cd backend && npm test`); `test-all.js` 7/7 layers pass; 325 Python tests still OK (skipped=8); live 401 walls verified; engine health cache 1.17s → 5ms on repeat; TTS-with-JWT verified via curl (31,968 audio bytes) and from the browser origin (18,864 bytes). BE-B2 (unguarded JSON.parse of tool args) fixed early as part of BE-S5. `server.js` now exports `{ app, startServer }` and only auto-starts as entry point, so supertest can drive the real app. `agentRoutes.js` needed no change (limiters mount in `server.js`).

### Stage 2 — Reliability & correctness
FE-1.1–1.6 (mic cancellation, fetch abort/timeouts, TTS interrupt, overlap, recognition race, logout/pagehide cleanup), FE-3.2 (401 recovery); BE-B2/B3/B4/B5/B7/B9, BE-S9 (error hygiene), BE-S11 (regex escaping), BE-S12 (password policy).
*Verify:* new unit/integration tests per fix; browser mic/TTS/logout walkthrough.

### Stage 3 — Test infrastructure (Prompt 6)
Expand the Stage-1 harness into full backend integration coverage (auth, JWT authZ, chat + mocked AI failure, TTS fallback, tasks, uploads + limits, PDF/OCR/spreadsheet/JSON/archive via engine, persistence, user isolation, cleanup); add frontend tests (light DOM runner) for Proxy state, storage, XSS rendering, voice fallback, API client; failure scenarios (401/429/500, aborts); test-report generator. **Preserve all 325 Python tests.**
*Verify:* every suite executed; report generated.

### Stage 4 — Cleanup, dedup, performance
DEP-1/2 (remove root legacy deps → root audit clean), FE-2.1–2.4 (shared `utils/storage.js` + `utils/apiClient.js`, reuse `voiceService.speak` in file assistant), FE-6.1 (wire or drop dashboard.js), FE-1.9/BE-B11 dead code, BE-B8 (multer/options factory), BE-P1 (semaphore + health cache), BE-E2/E3 (child tracking, SIGKILL escalation, byte caps), BE-B10 (graceful shutdown), BE-S7 (CORS allowlist + prod CSP), BE-S8 (magic bytes + extraction timeout), BE-P3 (JSON cap).
*Verify:* root+backend `npm audit` clean, 325 engine tests, full suite, latency re-measure.

### Stage 5 — Advanced voice system (Prompt 2)
Clean voice-service architecture with explicit state machine (idle/listening/thinking/speaking/error); mic permission pre-check + guidance; honest browser-STT handling (interim feedback, optional conversation-mode auto-relisten — no fake streaming claims); **real** AnalyserNode waveform + activity indicators; interrupt/barge-in, pause/resume, volume, voice selection, speed controls; transcript turn-sync; overlap prevention; full resource cleanup. Uses existing `/tts`, `/voices`, `/process` routes.
*Verify:* voice unit tests + browser checklist of all 15 Prompt-2 requirements.

### Stage 6 — Intelligent memory (Prompt 4)
Extend categories (short-term ✓, long-term preferences, project, task, summaries); relevance retrieval + dedupe + per-user caps; periodic summarization of older conversations; new `memoryRoutes.js` (list/edit/delete/clear-session — reuses existing service functions, BE-M1); expiration policies per category; indexes incl. BE-B5 unique partial index; **additive migration preserving existing docs**.
*Verify:* memory tests (isolation, dedupe, TTL, migration dry-run), memory API live checks.

### Stage 7 — UI redesign: Dark Aurora Workspace (Prompt 3)
Sub-stages: (a) app shell + left sidebar (Home/Chat/Tasks/Files/Voice/Memory/Settings); (b) main dashboard (avatar, greeting, quick actions, recent conversation, voice centre) + right sidebar (pending tasks, recent files, memory status, system health); (c) voice centre (large animated mic, real waveform, indicators, stop/interrupt, voice settings); (d) memory management view (Stage-6 APIs); (e) responsive desktop/tablet/mobile + accessibility (contrast FE-5.5, focus traps FE-5.2–5.4, keyboard presets FE-5.3, loading/empty/error states, reusable CSS components). Midnight navy / electric violet / aurora cyan / soft pink, glassmorphism, restrained motion. **All existing functionality and API integrations preserved — no static mockups.** Includes FE-3.1 (fetch file list), FE-6.2 (chat history), FE-5.6 (busy-state feedback).
*Verify:* browser walkthrough at desktop/tablet/mobile widths, keyboard-only pass, contrast checks, full regression suite.

### Stage 8 — Final QA & hardening pass
Re-run security checklist against all fixes, `npm audit` both roots, response-time benchmarks, rate-limit sanity, complete test report, refresh README/PROJECT_DETAILS.

---

## Appendix — evidence executed during this audit

| Check | Result |
|-------|--------|
| `npm audit --omit=dev` (backend) | 0 vulnerabilities |
| `npm audit` (root) | 1 High: xlsx prototype pollution + ReDoS, no npm fix |
| Python engine `unittest discover -s tests` | **Ran 325 tests — OK (skipped=8)**, 17.8 s |
| Live latency | / 8.7 ms · file-assistant/health 2.5 ms · voice/voices 4.2 ms · file-processing/health ~1.1 s per call |
| Engine capabilities | txt/csv/pdf/docx/xlsx/xlsm/tabular/json/archive/gnuTar/utils true; ocr/convert/jq false (binaries not detected) |
| Critical-finding code verification | BE-S1/S4/S5/S10, BE-B1, FE-1.1/1.2, FE-3.1/3.4, FE-6.1, BE-S11, FE-5.5 all re-checked directly in source |