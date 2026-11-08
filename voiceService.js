// ============================================
// services/voiceService.js — Lifelike Neural Voice Service
// ============================================
// Supports:
// 1. Natural Neural Speech Synthesis (Edge Neural Engine)
//    - Real Indian English and Hindi human-like voices
//    - Zero robotic tone, sounds like a real person talking!
// 2. Text clean-up for natural audio cadence
// 3. Fallback compatibility with browser Web Speech
// ============================================

const { EdgeTTS } = require('node-edge-tts');

// Curated list of human-like neural voices (Indian + Global)
const CURATED_NEURAL_VOICES = [
  {
    id: 'en-IN-NeerjaNeural',
    name: 'Neerja (Indian English - Warm & Natural Bestie)',
    lang: 'en-IN',
    gender: 'Female',
    recommended: true,
  },
  {
    id: 'en-IN-AnanyaNeural',
    name: 'Ananya (Indian English - Cheerful & Friendly)',
    lang: 'en-IN',
    gender: 'Female',
  },
  {
    id: 'en-IN-KavyaNeural',
    name: 'Kavya (Indian English - Soft & Expressive)',
    lang: 'en-IN',
    gender: 'Female',
  },
  {
    id: 'hi-IN-SwaraNeural',
    name: 'Swara (Hindi - Sweet & Caring)',
    lang: 'hi-IN',
    gender: 'Female',
  },
  {
    id: 'hi-IN-MadhurNeural',
    name: 'Madhur (Hindi - Gentle Male)',
    lang: 'hi-IN',
    gender: 'Male',
  },
  {
    id: 'en-IN-PrabhatNeural',
    name: 'Prabhat (Indian English - Natural Male)',
    lang: 'en-IN',
    gender: 'Male',
  },
  {
    id: 'en-US-JennyNeural',
    name: 'Jenny (US English - Expressive Female)',
    lang: 'en-US',
    gender: 'Female',
  },
  {
    id: 'en-GB-SoniaNeural',
    name: 'Sonia (UK English - Polite Female)',
    lang: 'en-GB',
    gender: 'Female',
  },
];

// Clean text for natural speech (remove markdown symbols, URLs, etc.)
function cleanTextForSpeech(text) {
  if (!text) return '';
  return text
    // Remove markdown formatting like **bold**, *italic*, # heading
    .replace(/[*#_`~]/g, '')
    // Remove URLs
    .replace(/https?:\/\/\S+/g, '')
    // Replace markdown links [label](url) with label
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove bullet point asterisks
    .replace(/^\s*[-*+]\s+/gm, '')
    // Remove extra whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate Neural Speech Audio Stream (MP3)
 * @param {string} text - The text to speak
 * @param {object} options - { voice, rate, pitch }
 * @returns {AsyncGenerator<Buffer>}
 */
function generateSpeechStream(text, options = {}) {
  const clean = cleanTextForSpeech(text);
  if (!clean) {
    throw new Error('No text to speak');
  }

  const voice = options.voice || 'en-IN-NeerjaNeural';
  const rate = options.rate || '+0%';
  const pitch = options.pitch || '+0Hz';

  const tts = new EdgeTTS({
    voice,
    rate,
    pitch,
  });

  return tts.streamAudio(clean);
}

/**
 * Process voice text input from the client (for voice-to-voice)
 */
async function processVoiceInput(text, agentFn, userId) {
  if (!text || text.trim().length === 0) {
    return {
      reply: "I didn't catch that. Could you say it again? 😊",
      success: false,
    };
  }

  const result = await agentFn(text.trim(), userId);

  return {
    reply: result.reply,
    toolResults: result.toolResults || [],
    success: true,
  };
}

module.exports = {
  CURATED_NEURAL_VOICES,
  generateSpeechStream,
  cleanTextForSpeech,
  processVoiceInput,
};
