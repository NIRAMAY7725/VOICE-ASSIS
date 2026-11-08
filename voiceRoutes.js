// ============================================
// routes/voiceRoutes.js — Voice & Neural Audio Routes
// ============================================
// ENDPOINTS:
//   POST /api/voice/process → Process voice-transcribed text (requires auth)
//   GET  /api/voice/voices  → List curated human-like neural voices
//   POST /api/voice/tts     → Synthesize neural MP3 audio (requires auth)
// ============================================

const express = require('express');
const { z } = require('zod');
const { protect } = require('../middleware/auth');
const voiceService = require('../services/voiceService');
const { processMessage } = require('../agents/mainAgent');

const router = express.Router();

// ===================== ZOD SCHEMAS =====================

const voiceInputSchema = z.object({
  text: z.string().min(1, 'Voice text cannot be empty').max(2000),
  sessionId: z.string().optional(),
});

// SECURITY: node-edge-tts interpolates voice/rate/pitch straight into SSML
// (<voice name="…"><prosody rate="…" pitch="…">). Arbitrary strings could break
// out and inject markup, so whitelist the voice and pattern-match rate/pitch.
const ALLOWED_VOICE_IDS = new Set(voiceService.CURATED_NEURAL_VOICES.map((v) => v.id));

const ttsSchema = z.object({
  text: z.string().min(1, 'Text cannot be empty').max(2000),
  voice: z
    .string()
    .refine((v) => ALLOWED_VOICE_IDS.has(v), 'Unknown voice. Choose one from GET /api/voice/voices.')
    .optional(),
  rate: z.string().regex(/^[+-]\d{1,3}%$/, 'Rate must look like +0% or -10%.').optional(),
  pitch: z.string().regex(/^[+-]\d{1,3}Hz$/, 'Pitch must look like +0Hz or -3Hz.').optional(),
});

// ===================== ROUTES =====================

// GET /api/voice/voices — List curated natural voices
router.get('/voices', (req, res) => {
  res.json({
    success: true,
    voices: voiceService.CURATED_NEURAL_VOICES,
  });
});

// POST /api/voice/tts — Stream realistic neural audio MP3 (requires auth so the
// server can't be used as an open Edge-TTS relay; still per-IP rate-limited).
router.post('/tts', protect, async (req, res) => {
  try {
    const data = ttsSchema.parse(req.body);

    const stream = voiceService.generateSpeechStream(data.text, {
      voice: data.voice,
      rate: data.rate,
      pitch: data.pitch,
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');

    for await (const chunk of stream) {
      if (Buffer.isBuffer(chunk)) {
        res.write(chunk);
      }
    }

    res.end();
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: error.issues.map((e) => e.message).join(', '),
      });
    }
    console.error('TTS synthesis error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Failed to synthesize speech audio.',
      });
    }
  }
});

// POST /api/voice/process — Process voice input through AI
router.post('/process', protect, async (req, res) => {
  try {
    const data = voiceInputSchema.parse(req.body);

    const result = await voiceService.processVoiceInput(
      data.text,
      (text) => processMessage(text, req.user._id.toString(), data.sessionId, { voiceMode: true }),
      req.user._id.toString()
    );

    res.json({
      success: result.success,
      reply: result.reply,
      toolResults: result.toolResults || [],
    });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: error.issues.map((e) => e.message).join(', '),
      });
    }
    console.error('Voice processing error:', error);
    res.status(500).json({
      success: false,
      error: 'Something went wrong processing your voice input.',
    });
  }
});

module.exports = router;
