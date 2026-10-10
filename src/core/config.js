const path = require('path');
const os = require('os');

class ConfigManager {
  constructor() {
    this.env = process.env.NODE_ENV || 'development';
    this.appDataDir = path.join(os.homedir(), '.JobAI');
    this.loadConfiguration();
  }

  loadConfiguration() {
    this.config = {
      app: {
        // Display name shown in window titles and UI text. Set APP_NAME in .env.
        name: (process.env.APP_NAME || '').trim() || 'Code',
        version: '1.0.0',
        // Name the OS shows for the process / app. Set APP_PROCESS_NAME in .env.
        processTitle: process.env.APP_PROCESS_NAME || 'Terminal ',
        dataDir: this.appDataDir,
        isDevelopment: this.env === 'development',
        isProduction: this.env === 'production'
      },
      
      window: {
        defaultWidth: 400,
        defaultHeight: 600,
        minWidth: 300,
        minHeight: 400,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          enableRemoteModule: false,
          preload: path.join(__dirname, '../../preload.js')
        }
      },

      ocr: {
        language: 'eng',
        tempDir: os.tmpdir(),
        cleanupDelay: 5000
      },

      llm: {
        // Which model answers depends on the mode. A route is used only when
        // its provider has an API key; otherwise the provider chosen in
        // Settings answers. Turn off with LLM_ROUTING=off.
        routing: {
          // Interview mode: spoken questions, so favour speed.
          interview: {
            provider: 'gemini',
            model: 'gemini-3.1-flash-lite',
            fallbackModels: ['gemini-3-flash-preview']
          },
          // Coding mode: favour quality, using the custom provider's default
          // model at medium effort and a larger token budget.
          dsa: {
            provider: 'gateway',
            useDefault: true,
            effort: 'medium',
            maxTokens: 8000
          }
        },
        gemini: {
          model: 'gemini-3-flash-preview',
          fallbackModels: ['gemini-3.1-flash-lite', 'gemini-3.5-flash'],
          maxRetries: 3,
          timeout: 30000,
          fallbackEnabled: true,
          enableFallbackMethod: true,
          generation: {
            temperature: 0.7,
            topK: 32,
            topP: 0.9,
            maxOutputTokens: 4096,
            thinkingConfig: { thinkingBudget: 0 }
          }
        },
        gateway: {
          // Used only when the model list in Settings is empty.
          model: 'openai/gpt-5',
          fallbackModels: [],
          // Fail fast and move to the next model: one retry, only for
          // network trouble; a silent model is abandoned after 20 s (streaming)
          // or 45 s (whole answer).
          maxRetries: 2,
          timeout: 45000,
          firstByteTimeout: 20000,
          maxConcurrent: 3,
          maxTokens: 4096
        }
      },

      speech: {
        provider: 'azure',
        azure: {
          language: 'en-US',
          enableDictation: true,
          enableAudioLogging: false,
          outputFormat: 'detailed'
        },
        whisper: {
          model: 'small',
          language: 'auto',
          // segmentMs is the legacy fixed-window size and now acts as the
          // hard upper bound for a single utterance when VAD is enabled.
          segmentMs: 4000,
          // Voice-activity-detection driven segmentation. Instead of cutting
          // audio on a blind timer (which splits sentences mid-word), we flush
          // a segment when the speaker pauses. This makes transcription align
          // with natural utterance boundaries.
          vadEnabled: true,
          // Trailing silence (ms) that ends an utterance and triggers a flush.
          silenceHangoverMs: 700,
          // Minimum accumulated speech (ms) before a pause counts as an
          // utterance — guards against coughs/clicks producing empty flushes.
          minUtteranceMs: 350,
          // Hard cap (ms): force-flush a long monologue even without a pause.
          maxUtteranceMs: 15000,
          // Pre-roll (ms) of audio kept before speech onset so the first
          // syllable isn't clipped when we start capturing.
          preRollMs: 300,
          // Absolute RMS energy floor (normalized 0..1). Energy below this is
          // always treated as silence regardless of the adaptive noise floor.
          vadEnergyFloor: 0.008
        }
      },

      session: {
        maxMemorySize: 1000,
        compressionThreshold: 500,
        clearOnRestart: false
      },

      stealth: {
        hideFromDock: true,
        noAttachConsole: true,
        disguiseProcess: true
      }
    };
  }

  get(keyPath) {
    return keyPath.split('.').reduce((obj, key) => obj?.[key], this.config);
  }

  set(keyPath, value) {
    const keys = keyPath.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((obj, key) => obj[key] = obj[key] || {}, this.config);
    target[lastKey] = value;
  }

  getApiKey(service) {
    const envKey = `${service.toUpperCase()}_API_KEY`;
    return process.env[envKey];
  }

  isFeatureEnabled(feature) {
    return this.get(`features.${feature}`) !== false;
  }
}

module.exports = new ConfigManager();
