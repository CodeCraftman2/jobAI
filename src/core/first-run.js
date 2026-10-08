const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * First-run detection and onboarding helper.
 *
 * Responsibilities:
 *   - Decide whether this is the user's first launch of JobAI
 *   - Auto-create a default `.env` from `env.example` if one is missing
 *   - Report whether an LLM API key (Gemini or Anthropic) is configured
 *   - Persist a "first-run completed" sentinel so we don't nag on every launch
 *
 * The settings UI is the source of truth for API-key entry. This module
 * only handles the bootstrap so the user has something to edit on first
 * launch.
 */
class FirstRunManager {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.envPath = options.envPath || path.join(this.cwd, '.env');
    this.sentinelPath = options.sentinelPath || path.join(this.cwd, '.jobai-firstrun-completed');
    this.logger = options.logger || console;
    // Optional keychain: keys saved there do not appear in .env.
    this.secrets = options.secrets || null;
  }

  /**
   * Returns true if this looks like a fresh install — no .env, no
   * sentinel file, or .env exists but has no Gemini key (required: it
   * answers interview questions and is the fallback for every other AI).
   */
  needsOnboarding() {
    if (!fs.existsSync(this.sentinelPath)) return true;
    if (!fs.existsSync(this.envPath)) return true;
    const content = this._readEnv();
    return !this._hasLlmKey(content);
  }

  /** True when the required Gemini key is real. */
  _hasLlmKey(env) {
    const real = (v) => {
      const t = (v || '').trim();
      return !!t && !/^your[-_]/i.test(t);
    };
    return real(env.GEMINI_API_KEY);
  }

  /**
   * Ensures a .env file exists. If not, copies env.example (if available)
   * or writes a minimal template.
   */
  ensureEnv() {
    if (fs.existsSync(this.envPath)) {
      return { created: false, path: this.envPath };
    }

    const template = this._readTemplate();
    const dir = path.dirname(this.envPath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.envPath, template, 'utf8');
      try {
        fs.chmodSync(this.envPath, 0o600);
      } catch (_) { /* best effort */ }
      return { created: true, path: this.envPath };
    } catch (e) {
      this.logger.error && this.logger.error('Failed to create .env', { error: e.message });
      return { created: false, path: this.envPath, error: e.message };
    }
  }

  /**
   * Mark the first-run as completed so we don't keep prompting.
   */
  markCompleted() {
    try {
      fs.writeFileSync(this.sentinelPath, new Date().toISOString(), 'utf8');
    } catch (e) {
      this.logger.warn && this.logger.warn('Could not write first-run sentinel', {
        error: e.message
      });
    }
  }

  /**
   * Get a snapshot of the current setup state for UI / logging.
   */
  getStatus() {
    const env = this._readEnv();
    const gemini = (env.GEMINI_API_KEY || '').trim();
    return {
      envExists: fs.existsSync(this.envPath),
      sentinelExists: fs.existsSync(this.sentinelPath),
      geminiConfigured: !!gemini && gemini !== 'your_gemini_api_key_here',
      anthropicConfigured: [env.GATEWAY_API_KEY, env.ANTHROPIC_API_KEY].some((k) => !!(k || '').trim() && !/^your[-_]/i.test(k.trim())),
      azureConfigured: !!(env.AZURE_SPEECH_KEY || '').trim() && !!(env.AZURE_SPEECH_REGION || '').trim(),
      whisperConfigured: !!(env.WHISPER_COMMAND || '').trim(),
      needsOnboarding: this.needsOnboarding()
    };
  }

  _readEnv() {
    try {
      const content = fs.readFileSync(this.envPath, 'utf8');
      const result = {};
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();

        // If the value is quoted, find the matching closing quote and
        // take everything between. Anything after the closing quote is
        // treated as trailing whitespace/comment.
        if (value.startsWith('"') || value.startsWith("'")) {
          const quote = value[0];
          const closeIdx = value.indexOf(quote, 1);
          if (closeIdx !== -1) {
            value = value.slice(1, closeIdx);
          }
        } else {
          // Unquoted: strip trailing inline comment (a " #" sequence).
          const hashIdx = value.indexOf(' #');
          if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
        }

        result[key] = value;
      }
      return this._withSecrets(result);
    } catch (_) {
      return this._withSecrets({});
    }
  }

  /** Keys kept in the OS keychain count as set even though .env has them empty. */
  _withSecrets(env) {
    if (!this.secrets || typeof this.secrets.get !== 'function') return env;
    for (const key of ['GEMINI_API_KEY', 'GATEWAY_API_KEY', 'AZURE_SPEECH_KEY']) {
      if (!(env[key] || '').trim()) {
        const stored = this.secrets.get(key);
        if (stored) env[key] = stored;
      }
    }
    return env;
  }

  _readTemplate() {
    // Prefer env.example if it ships in the project; otherwise write a
    // minimal template that the user can extend.
    const candidates = [
      path.join(this.cwd, 'env.example'),
      path.join(__dirname, '..', '..', 'env.example'),
    ];
    for (const candidate of candidates) {
      try {
        return fs.readFileSync(candidate, 'utf8');
      } catch (_) { /* try next */ }
    }
    return [
      '# JobAI configuration',
      '# GEMINI_API_KEY is required (interview answers + fallback). GATEWAY_API_KEY is optional: an OpenRouter key, say.',
      '# Gemini key: https://aistudio.google.com/apikey   OpenRouter key: https://openrouter.ai/keys',
      '',
      'GEMINI_API_KEY=your_gemini_api_key_here',
      '# Custom provider (any model): API key, then base URL and model list in Settings',
      'GATEWAY_API_KEY=your_api_key_here',
      '# LLM_PROVIDER: "gemini" or "gateway" (defaults to gemini, or gateway if only that key is set)',
      'LLM_PROVIDER=gemini',
      '',
      '# Speech provider: "whisper" (local) or "azure" (cloud).',
      '# WHISPER_COMMAND is auto-set to the project-local venv when you',
      '# install Whisper through the onboarding wizard, so no PATH change',
      '# or restart is needed.',
      'SPEECH_PROVIDER=whisper',
      'WHISPER_COMMAND=whisper',
      '# WHISPER_MODEL_DIR is optional. Leave it unset and the app stores model',
      '# weights in a stable app-data folder. Set an absolute path to override.',
      '# WHISPER_MODEL_DIR=',
      'WHISPER_MODEL=small',
      'WHISPER_LANGUAGE=auto',
      'WHISPER_DEVICE=auto',
      'WHISPER_PYTHON=',
      'WHISPER_CAPTURE_MODE=vad',
      'WHISPER_MANUAL_MAX_MS=90000',
      'WHISPER_GPU_IDLE_MS=60000',
      'WHISPER_SEGMENT_MS=4000',
      ''
    ].join(os.EOL);
  }
}

module.exports = FirstRunManager;
module.exports.FirstRunManager = FirstRunManager;
