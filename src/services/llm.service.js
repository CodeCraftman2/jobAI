const { GoogleGenAI } = require('@google/genai');
const logger = require('../core/logger').createServiceLogger('LLM');
const config = require('../core/config');
const { promptLoader } = require('../../prompt-loader');
const ocrService = require('./ocr.service');
const { sanitizeRequest, redactSecrets, limitText } = require('../core/privacy');
const modelHealth = require('../core/model-health');
const visionProbe = require('../core/vision-probe');

class LLMService {
  constructor() {
    this.client = null;
    this.model = null;
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;

    this.initializeClient();
  }

  /**
   * Pick the active provider. LLM_PROVIDER wins when set to a known value;
   * otherwise use Gemini, unless only a custom-provider key is configured.
   */
  resolveProvider() {
    const requested = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
    if (requested === 'gemini' || requested === 'gateway') return requested;
    return !this.hasValidKey('GEMINI') && this.hasValidKey('GATEWAY') ? 'gateway' : 'gemini';
  }

  hasValidKey(service) {
    const key = (config.getApiKey(service) || '').trim();
    return !!key && !/^your[-_]/i.test(key);
  }

  // ── Custom provider (any model behind a gateway) ──────────────────────
  // Settings: base URL, API key, credential kind, wire format, model list,
  // default effort. Works with Anthropic-style (/messages) and OpenAI-style
  // (/chat/completions) endpoints, which covers OpenRouter, Gemini's OpenAI
  // endpoint, Groq, Together, Ollama, LiteLLM and similar.

  /** Model list from Settings (comma or newline separated; first is the default). */
  gatewayModelList() {
    const split = (v) => String(v || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    const listed = split(process.env.GATEWAY_MODELS);
    if (listed.length) return listed;
    if (this._discoveredModels && this._discoveredModels.length) return this._discoveredModels;
    return [config.get('llm.gateway.model')];
  }

  /** The default route: first listed model, the rest as fallbacks. */
  gatewayDefaultRoute() {
    const [model, ...rest] = this.gatewayModelList();
    const effort = (process.env.GATEWAY_EFFORT || 'medium').trim().toLowerCase();
    const route = {
      provider: 'gateway',
      isDefault: true,
      model,
      fallbackModels: [...rest, ...(config.get('llm.gateway.fallbackModels') || [])]
    };
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) route.effort = effort;
    return route;
  }

  /**
   * Resolved connection settings. `overrides` (apiKey, baseUrl, auth, format)
   * lets Settings test values that are typed but not saved yet.
   */
  gatewayConfig(overrides = {}) {
    const pick = (o, env) => (o !== undefined && o !== null ? String(o) : (process.env[env] || '')).trim();
    const apiKey = pick(overrides.apiKey, 'GATEWAY_API_KEY');
    const customBase = pick(overrides.baseUrl, 'GATEWAY_BASE_URL').replace(/\/+$/, '');
    const isOpenRouter = apiKey.startsWith('sk-or-') || /openrouter\.ai/i.test(customBase);
    const isAnthropicHost = !customBase || /(^|\/\/)api\.anthropic\.com/i.test(customBase);
    const baseUrl = customBase || (isOpenRouter ? 'https://openrouter.ai/api/v1' : 'https://api.anthropic.com/v1');

    let format = pick(overrides.format, 'GATEWAY_FORMAT').toLowerCase();
    if (format !== 'anthropic' && format !== 'openai') {
      format = isAnthropicHost || isOpenRouter ? 'anthropic' : 'openai';
    }
    let authStyle = pick(overrides.auth, 'GATEWAY_AUTH').toLowerCase();
    if (authStyle !== 'x-api-key' && authStyle !== 'bearer') {
      authStyle = isAnthropicHost || (format === 'anthropic' && !isOpenRouter) ? 'x-api-key' : 'bearer';
    }
    return { apiKey, baseUrl, authStyle, format, isOpenRouter };
  }

  gatewayHeaders(cfg, extra = {}) {
    return {
      ...(cfg.authStyle === 'bearer' ? { Authorization: `Bearer ${cfg.apiKey}` } : { 'x-api-key': cfg.apiKey }),
      ...(cfg.format === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
      ...extra
    };
  }

  /** List the models the gateway offers (GET {base}/models). */
  async listGatewayModels(overrides = {}) {
    const cfg = this.gatewayConfig(overrides);
    if (!cfg.apiKey) return { success: false, error: 'Enter an API key first.' };
    try {
      const started = Date.now();
      const res = await this._gatewayGet(`${cfg.baseUrl}/models`, this.gatewayHeaders(cfg), 10000);
      if (res.status < 200 || res.status >= 300) {
        return { success: false, status: res.status, error: this._gatewayStatusMessage(res.status, res.body.slice(0, 200), '/models') };
      }
      const json = JSON.parse(res.body);
      const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
      const models = [];
      const free = [];
      const nonText = [];
      const vision = [];
      const noImageInput = [];
      let pricingKnown = false;
      for (const m of list) {
        const id = (typeof m === 'string' ? m : (m.id || m.name || '')).replace(/^models\//, '');
        if (!id) continue;
        models.push(id);
        if (typeof m === 'string') continue;
        // Some gateways (Kilo, OpenRouter) say which models are free; most do not.
        const price = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));
        if (m.isFree !== undefined || m.pricing) pricingKnown = true;
        if (m.isFree === true || /:free$/.test(id) || (price(m.pricing?.prompt) === 0 && price(m.pricing?.completion) === 0)) free.push(id);
        const out = m.architecture?.output_modalities;
        if (Array.isArray(out) && !out.includes('text')) nonText.push(id);
        // Which models can read an image (OpenRouter, Kilo and others say so).
        const inp = m.architecture?.input_modalities ?? m.input_modalities ?? m.modalities?.input;
        if (Array.isArray(inp)) (inp.includes('image') ? vision : noImageInput).push(id);
      }
      return { success: true, models, free, nonText, vision, noImageInput, pricingKnown, latency: Date.now() - started };
    } catch (e) {
      // Connection failures to several addresses arrive as an AggregateError with an empty message.
      const parts = (e.errors || []).map(x => `${x.address || '?'}:${x.port || '?'} ${x.code || x.message}`);
      const why = parts.length ? parts.join(', ') : (e.code ? `${e.code}: ${e.message}` : e.message);
      return { success: false, error: `Cannot reach ${cfg.baseUrl} (${why})` };
    }
  }

  /** GET with Node's http(s), the same transport chat requests use. */
  _gatewayGet(url, headers, timeout) {
    const target = new URL(url);
    const lib = target.protocol === 'http:' ? require('http') : require('https');
    return new Promise((resolve, reject) => {
      const req = lib.request(target.href, { method: 'GET', headers: { ...headers, 'User-Agent': this.getUserAgent() }, timeout }, (res) => {
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })); });
      req.end();
    });
  }

  _gatewayStatusMessage(status, body, what) {
    if (status === 401 || status === 403) return `Rejected the credentials (HTTP ${status}). Check the API key and the credential kind.`;
    if (status === 404) return `${what} not found at this URL (HTTP 404). Check the base URL and API format.`;
    if (status === 429) return 'Rate limited (HTTP 429). The key works, but wait a moment.';
    return `HTTP ${status}${body ? ': ' + body : ''}`;
  }

  /**
   * Discovery runs when asked for (GATEWAY_DISCOVERY=true) and, with an
   * OpenRouter key, by default: the user pastes a key and the app finds which
   * models answer. GATEWAY_DISCOVERY=false turns it off.
   */
  discoveryWanted() {
    const flag = (process.env.GATEWAY_DISCOVERY || '').trim().toLowerCase();
    if (flag === 'true') return true;
    if (flag === 'false') return false;
    return this.gatewayConfig().isOpenRouter;
  }

  /**
   * Fill the model list from the gateway when discovery is on and no list was
   * typed, so a typed list skips the request.
   */
  async refreshDiscoveredModels() {
    this._discoveredModels = null;
    if (!this.discoveryWanted() || !this.hasValidKey('GATEWAY')) return;
    if ((process.env.GATEWAY_MODELS || '').trim()) return;
    const baseUrl = this.gatewayConfig().baseUrl;
    const remembered = modelHealth.getDiscovered(baseUrl);
    if (remembered && remembered.length && !this._forceRescan) {
      this._discoveredModels = remembered;
      this._discoveredAt = Date.now();
      if (this.provider === 'gateway') this.model = remembered[0];
      logger.info('Using remembered gateway models', { models: remembered });
      return;
    }
    // Providers list hundreds of models; testing two dozen is enough.
    const r = await this.autoPickModels({}, { maxProbes: 24, concurrency: 6 });
    if (r.success && r.models.length) {
      this._discoveredModels = r.models;
      this._discoveredAt = Date.now();
      modelHealth.setDiscovered(baseUrl, r.models);
      if (this.provider === 'gateway') this.model = r.models[0];
      logger.info('Discovered working gateway models', { models: r.models, tested: r.tested });
    } else {
      logger.warn('Gateway model discovery failed', { error: r.error || 'no models returned' });
    }
  }

  /**
   * Make sure a model list exists before the first request, so the first
   * answer after install is already routed across working models. Shared, so
   * parallel requests wait for one scan. `force` re-scans (used to reroll
   * after every known model failed).
   */
  async ensureGatewayModels(force = false) {
    if (!this.discoveryWanted() || !this.hasValidKey('GATEWAY')) return;
    if ((process.env.GATEWAY_MODELS || '').trim()) return;
    const fresh = this._discoveredModels && this._discoveredModels.length &&
      Date.now() - (this._discoveredAt || 0) < 30 * 60 * 1000;
    if (fresh && !force) return;
    if (!this._discovering) {
      this._forceRescan = force;
      this._discovering = this.refreshDiscoveredModels().finally(() => { this._discovering = null; this._forceRescan = false; });
    }
    await this._discovering;
  }

  /**
   * API test: are the URL and credentials accepted? Uses GET /models and, if
   * the gateway has no such endpoint, falls back to a one-token completion.
   */
  async testGatewayApi(overrides = {}) {
    const cfg = this.gatewayConfig(overrides);
    if (!cfg.apiKey) return { success: false, error: 'Enter an API key first.' };
    const listed = await this.listGatewayModels(overrides);
    if (listed.success) {
      return { success: true, latency: listed.latency, modelCount: listed.models.length, format: cfg.format, baseUrl: cfg.baseUrl };
    }
    if (listed.status === 404 || listed.status === 405) {
      const model = (overrides.models && overrides.models[0]) || this.gatewayModelList()[0];
      const r = await this.testGatewayModel(model, overrides);
      return r.success
        ? { success: true, latency: r.latency, modelCount: null, format: cfg.format, baseUrl: cfg.baseUrl, note: 'No /models endpoint; a test message worked.' }
        : r;
    }
    return { success: false, error: listed.error };
  }

  /** Model test: send a tiny message to one model and report the reply. */
  async testGatewayModel(model, overrides = {}) {
    const cfg = this.gatewayConfig(overrides);
    if (!cfg.apiKey) return { success: false, model, error: 'Enter an API key first.' };
    if (!model) return { success: false, error: 'No model to test. Add one to the model list.' };
    const started = Date.now();
    try {
      const request = {
        contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }],
        generationConfig: { maxOutputTokens: 256 }
      };
      const payload = this.buildGatewayPayload(request, model, false, null, cfg);
      // A dead model should fail fast instead of holding up a scan.
      const text = await this._gatewayHttpRequest(payload, null, { ...cfg, timeout: 20000 });
      return { success: true, model, latency: Date.now() - started, response: text.slice(0, 80) };
    } catch (error) {
      // Reasoning models can spend the whole budget thinking; they still answered.
      if (/stop reason: length/.test(error.message)) {
        return { success: true, model, latency: Date.now() - started, response: '(reasoning model: answered, no visible text yet)' };
      }
      const m = /HTTP (\d{3})/.exec(error.message);
      return { success: false, model, error: m ? this._gatewayStatusMessage(Number(m[1]), error.message.replace(/^HTTP \d+:\s*/, '').slice(0, 200), 'Model/endpoint') : error.message };
    }
  }

  /**
   * Heuristic: does this model id look like a text chat model? Catalogues such
   * as NVIDIA's list embedding, reranking, safety, vision-only, speech and
   * image models next to chat models and give no type field, so filter by name.
   */
  isChatModelId(id) {
    return !/embed|rerank|retriev|guard|safety|reward|parse|clip|vila|paligemma|fuyu|kosmos|neva|deplot|riva|tts|asr|whisper|parakeet|canary|diffusion|stable|flux|sdxl|cosmos|segment|ocr|moderation|translate|sana|nvclip|vista|bevformer|molmim|diffdock|genmol|esm|alphafold|openfold|evo2|lyria|veo|imagen|music|video|audio|speech/i.test(id);
  }

  /**
   * Auto-pick: list the gateway's models, send a tiny message to the ones that
   * look like chat models, and rank those that answer by speed. A model that
   * answers with your key is usable now (free tier or paid); the catalogue
   * itself does not say which is which, so a live answer is the test.
   */
  async autoPickModels(overrides = {}, { keep = 5, maxProbes = 120, concurrency = 8, freeOnly = null } = {}) {
    const listed = await this.listGatewayModels(overrides);
    if (!listed.success) return listed;
    if (freeOnly === null) freeOnly = (process.env.GATEWAY_FREE_ONLY || '').trim().toLowerCase() === 'true';
    const skip = new Set(listed.nonText);
    let pool = listed.models.filter(m => this.isChatModelId(m) && !skip.has(m));
    // Only filter when the gateway says which models are free; otherwise every
    // model is tested and a live answer is the only evidence.
    const freeKnown = listed.pricingKnown;
    if (freeOnly && freeKnown) {
      const freeSet = new Set(listed.free);
      pool = pool.filter(m => freeSet.has(m));
      if (!pool.length) return { success: false, error: 'The gateway lists no free chat models.' };
    }
    const candidates = pool.slice(0, maxProbes);
    if (!candidates.length) return { success: false, error: 'The gateway lists no chat models.' };

    const results = [];
    let next = 0;
    const worker = async () => {
      while (next < candidates.length) {
        const model = candidates[next++];
        results.push(await this.testGatewayModel(model, overrides));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));

    const working = results.filter(r => r.success).sort((a, b) => a.latency - b.latency);
    const failed = results.filter(r => !r.success).map(r => ({ model: r.model, error: r.error }));
    if (!working.length) {
      return { success: false, error: `None of the ${candidates.length} models tested answered. First error: ${failed[0]?.error || 'unknown'}`, failed };
    }
    return {
      success: true,
      models: working.slice(0, keep).map(r => r.model),
      working: working.map(r => ({ model: r.model, latency: r.latency })),
      failed,
      listed: listed.models.length,
      tested: candidates.length,
      freeKnown,
      freeOnly: !!(freeOnly && freeKnown)
    };
  }

  // ── Images ────────────────────────────────────────────────────────────
  // Screenshots (and the screen sent with a spoken question) need a model that
  // can read images. Many models cannot, so image requests are ordered
  // vision-first and may use vision models the typed list does not name.

  requestHasImage(request) {
    return (request?.contents || []).some(c => (c.parts || []).some(p => p.inlineData?.data));
  }

  /** Same request without its images (used when no model can read them). */
  withoutImages(request) {
    const copy = {
      ...request,
      contents: (request.contents || [])
        .map(c => ({ ...c, parts: (c.parts || []).filter(p => !p.inlineData) }))
        .filter(c => c.parts.length)
    };
    for (const key of ['_route', '_used']) {
      if (request[key] !== undefined) Object.defineProperty(copy, key, { value: request[key], enumerable: false, writable: true, configurable: true });
    }
    return copy;
  }

  /**
   * The request with each image replaced by the text OCR reads from it, or
   * null when OCR is off, fails, or finds no text.
   */
  async withOcrText(request) {
    if (!ocrService.enabled()) return null;
    try {
      const copy = this.withoutImages(request);
      const texts = [];
      for (const content of request.contents || []) {
        for (const part of content.parts || []) {
          if (!part.inlineData?.data) continue;
          const text = await ocrService.recognize(Buffer.from(part.inlineData.data, 'base64'));
          if (text) texts.push(text);
        }
      }
      if (!texts.length) return null;
      // Attach to the last user message, where the screenshot was.
      const last = [...copy.contents].reverse().find(c => c.role === 'user');
      if (!last) return null;
      // What is on screen may include secrets; redact and cap it like any other text.
      const screenText = redactSecrets(limitText(texts.join('\n\n'), 8000));
      last.parts = [...last.parts, {
        text: '\n\n[The screenshot could not be sent as an image. This is the text read from it with OCR, which may contain mistakes and loses layout and indentation:]\n' + screenText
      }];
      logger.info('Screenshot read with OCR', { chars: texts.join('').length });
      return copy;
    } catch (error) {
      logger.warn('OCR fallback failed', { error: error.message });
      return null;
    }
  }

  looksVision(id) {
    return /vision|(^|[-_/])vl([-_]|$)|pixtral|llava|omni|gpt-4o|gpt-4\.1|gpt-5|gemini|gemma-3|llama-?3\.2-(11|90)b|llama-?4|qwen.*vl|mistral-(small|medium)-3|kimi|grok-4/i.test(id);
  }

  /** What the gateway says about image support; cached, empty if it cannot be read. */
  async gatewayCatalog() {
    if (this._catalog && Date.now() - this._catalog.at < 10 * 60 * 1000) return this._catalog;
    const empty = { at: Date.now(), vision: new Set(), noImage: new Set(), picks: [] };
    try {
      const r = await this.listGatewayModels();
      if (!r.success) { this._catalog = empty; return empty; }
      const freeOnly = (process.env.GATEWAY_FREE_ONLY || '').trim().toLowerCase() === 'true';
      const free = new Set(r.free);
      let picks = r.vision.filter(m => this.isChatModelId(m) && !r.nonText.includes(m));
      if (freeOnly && r.pricingKnown) picks = picks.filter(m => free.has(m));
      else picks.sort((a, b) => Number(free.has(b)) - Number(free.has(a)));
      this._catalog = { at: Date.now(), vision: new Set(r.vision), noImage: new Set(r.noImageInput), picks: picks.slice(0, 6) };
    } catch (_) {
      this._catalog = empty;
    }
    return this._catalog;
  }

  /**
   * Can this model read an image? Asked by sending a tiny red square and
   * checking the answer, so it works for any provider and any model, whatever
   * the model list claims. Definite answers are remembered between launches;
   * network or rate-limit trouble is not (the model is tested again later).
   */
  async probeVision(model, cfg = null) {
    cfg = cfg || this.gatewayConfig();
    const key = `${cfg.baseUrl}|${model}`;
    const request = {
      contents: [{ role: 'user', parts: [{ text: visionProbe.PROBE_QUESTION }, { inlineData: { data: visionProbe.PROBE_IMAGE_BASE64, mimeType: 'image/png' } }] }],
      generationConfig: { maxOutputTokens: 256 }
    };
    try {
      const payload = this.buildGatewayPayload(request, model, false, null, cfg);
      const reply = await this._withSlot(() => this._gatewayHttpRequest(payload, null, { ...cfg, timeout: 15000 }));
      const ok = visionProbe.passed(reply);
      modelHealth.setVision(key, ok);
      logger.info('Vision probe', { model, ok });
      return ok;
    } catch (error) {
      const msg = String(error.message || '');
      // The model said no to images, or answered without seeing one.
      if (/HTTP (400|415|422)/.test(msg) || /No text in response/.test(msg) && !/length/.test(msg)) {
        modelHealth.setVision(key, false);
        logger.info('Vision probe', { model, ok: false, reason: 'rejected' });
      } else {
        logger.info('Vision probe inconclusive', { model, reason: this.shortError(error) });
      }
      return false;
    }
  }

  /**
   * Models that are confirmed to read images, fastest known first. Only these
   * ever receive the real screenshot. A model is confirmed by the provider's
   * own metadata, a remembered earlier test, or a fresh probe (a few at a
   * time, stopping at the first success).
   */
  async visionCandidates(models) {
    const cfg = this.gatewayConfig();
    const key = (m) => `${cfg.baseUrl}|${m}`;
    const cat = await this.gatewayCatalog();
    const pool = [...models, ...cat.picks.filter(m => !models.includes(m))];
    const yes = [];
    const unknown = [];
    for (const m of pool) {
      if (cat.noImage.has(m)) continue;
      const known = modelHealth.getVision(key(m));
      if (known === false) continue;
      if (known === true || cat.vision.has(m)) yes.push(m);
      else unknown.push(m);
    }
    if (!yes.length) {
      // Names that usually mean "sees images" are tested first.
      unknown.sort((a, b) => Number(this.looksVision(b)) - Number(this.looksVision(a)));
      const batch = unknown.slice(0, 6);
      for (let i = 0; i < batch.length && !yes.length; i += 3) {
        const slice = batch.slice(i, i + 3);
        const results = await Promise.all(slice.map(m => this.probeVision(m, cfg)));
        slice.forEach((m, j) => { if (results[j]) yes.push(m); });
      }
    }
    const speed = (m) => modelHealth.latency(key(m)) ?? Infinity;
    return yes.map((m, i) => ({ m, i })).sort((a, b) => (speed(a.m) - speed(b.m)) || (a.i - b.i)).map(x => x.m);
  }

  // ── Rollback ──────────────────────────────────────────────────────────
  // A model that fails is skipped for a while so the next requests go straight
  // to a working fallback, then it is tried first again once the cooldown ends.

  _modelOnCooldown(model) {
    const until = this._cooldowns && this._cooldowns.get(model);
    if (!until) return false;
    if (Date.now() >= until) { this._cooldowns.delete(model); return false; }
    return true;
  }

  _coolDownModel(model, errorMessage) {
    if (!this._cooldowns) this._cooldowns = new Map();
    // A model that does not exist or is not allowed rarely fixes itself fast.
    const long = /HTTP (400|401|402|403|404)/.test(errorMessage || '');
    const ms = (long ? 30 : 3) * 60 * 1000;
    this._cooldowns.set(model, Date.now() + ms);
    logger.warn('Model put on cooldown', { model, minutes: ms / 60000 });
  }

  /**
   * Work out which provider/model answers a request. Requests are tagged with
   * their mode by tagRoute(); a mode's route is used when its provider has a
   * key, otherwise the provider chosen in Settings answers.
   */
  tagRoute(request, activeSkill) {
    const routing = (process.env.LLM_ROUTING || '').trim().toLowerCase();
    const route = routing === 'off' ? null : config.get(`llm.routing.${String(activeSkill || '').toLowerCase()}`);
    // Non-enumerable so it is never serialised into the API request body.
    Object.defineProperty(request, '_route', { value: route || null, enumerable: false, writable: true, configurable: true });
    return request;
  }

  resolveRoute(request) {
    const wanted = request && request._route;
    // A mode can ask for the custom provider's default model (with its own
    // effort / token cap unless Settings sets an effort).
    if (wanted && wanted.provider === 'gateway' && wanted.useDefault && this.hasValidKey('GATEWAY')) {
      const route = this.gatewayDefaultRoute();
      if (!route.effort && wanted.effort) route.effort = wanted.effort;
      if (wanted.maxTokens) route.maxTokens = wanted.maxTokens;
      return route;
    }
    if (wanted && this.hasValidKey(wanted.provider.toUpperCase())) {
      return wanted;
    }
    if (this.provider === 'gateway') {
      return this.gatewayDefaultRoute();
    }
    return { provider: 'gemini', model: this.model, fallbackModels: config.get('llm.gemini.fallbackModels') || [] };
  }

  /** A default route on the other provider, when its key is configured. */
  alternateRoute(route) {
    const other = route.provider === 'gemini' ? 'gateway' : 'gemini';
    if (!this.hasValidKey(other.toUpperCase())) return null;
    if (other === 'gateway') {
      return this.gatewayDefaultRoute();
    }
    return {
      provider: 'gemini',
      model: config.get('llm.gemini.model'),
      fallbackModels: config.get('llm.gemini.fallbackModels') || []
    };
  }

  /**
   * Run on the request's route; if every model on it fails, try once on the
   * other provider (e.g. the custom provider out of credit -> Gemini).
   */
  /**
   * Everything that leaves the machine goes through here once per request:
   * secrets redacted, text and history capped, at most two images.
   */
  prepareRequest(request) {
    if (!request || request._prepared) return request;
    const stats = sanitizeRequest(request);
    Object.defineProperty(request, '_prepared', { value: true, enumerable: false, writable: true, configurable: true });
    if (stats.redactions || stats.truncatedParts || stats.droppedMessages || stats.droppedImages) {
      logger.info('Request trimmed before sending', stats);
    }
    return request;
  }

  /** At most `llm.gateway.maxConcurrent` requests to the gateway at once; the rest wait their turn. */
  async _withSlot(fn) {
    const max = Number(process.env.JOBAI_MAX_CONCURRENT_REQUESTS) || config.get('llm.gateway.maxConcurrent') || 3;
    this._active = this._active || 0;
    this._queue = this._queue || [];
    if (this._active >= max) await new Promise(resolve => this._queue.push(resolve));
    this._active++;
    try {
      return await fn();
    } finally {
      this._active--;
      const next = this._queue.shift();
      if (next) next();
    }
  }

  async withProviderFallback(request, run, canFallBack = () => true) {
    this.prepareRequest(request);
    const route = this.resolveRoute(request);
    try {
      return await run(route);
    } catch (error) {
      const alt = this.alternateRoute(route);
      if (!alt || !canFallBack()) {
        this.notify('error', `${this.providerLabel(route.provider)} failed: ${this.shortError(error)}`);
        throw error;
      }
      logger.warn('All models failed on the primary provider, trying the other provider', {
        from: route.provider,
        to: alt.provider,
        error: error.message
      });
      this.notify('warn', `${this.providerLabel(route.provider)} failed (${this.shortError(error)}). Using ${this.providerLabel(alt.provider)}.`);
      try {
        return await run(alt);
      } catch (altError) {
        this.notify('error', `All AI providers failed: ${this.shortError(altError)}`);
        throw altError;
      }
    }
  }

  providerLabel(provider) {
    return provider === 'gateway' ? 'Custom AI' : 'Gemini';
  }

  /** One short line for the UI out of a (possibly JSON-laden) error message. */
  shortError(error) {
    const msg = String((error && error.message) || error || 'unknown error');
    const http = /HTTP (\d{3})/.exec(msg);
    if (http) return `HTTP ${http[1]}`;
    return msg.replace(/^API failed after trying [^:]*:\s*/, '').replace(/\s+/g, ' ').slice(0, 80);
  }

  /** Let the UI know about a fallback or a failure. main.js sets noticeHandler. */
  notify(level, message) {
    logger[level === 'error' ? 'error' : 'warn']('LLM notice', { message });
    try {
      if (typeof this.noticeHandler === 'function') this.noticeHandler({ level, message });
    } catch (_) { /* a broken UI must not break answering */ }
  }

  /** Provider and model that will answer in the given mode (for the UI). */
  getActiveModel(activeSkill) {
    const route = this.resolveRoute(this.tagRoute({}, activeSkill));
    return { provider: route.provider, model: route.model };
  }

  /** Record which model actually answered (it can be a fallback). */
  markUsed(request, provider, model) {
    Object.defineProperty(request, '_used', { value: { provider, model }, enumerable: false, writable: true, configurable: true });
    logger.info('LLM answered', { provider, model });
  }

  /** Provider/model fields for response metadata. */
  answerInfo(request) {
    const used = request && request._used;
    if (used) return { provider: used.provider, model: used.model };
    const route = this.resolveRoute(request);
    return { provider: route.provider, model: route.model };
  }

  /** The Gemini SDK client; created on demand when Gemini is only used by a route. */
  getGeminiClient() {
    if (!this.client) {
      this.client = new GoogleGenAI({ apiKey: config.getApiKey('GEMINI') });
    }
    return this.client;
  }

  /**
   * Do the slow first-time work in the background so the first answer is not
   * the one that pays for it: find models, read the provider's catalogue (it
   * also opens the connection) and start the OCR worker if it is installed.
   */
  warmUp() {
    if (this._warming) return;
    this._warming = true;
    (async () => {
      try {
        if (this.hasValidKey('GATEWAY')) {
          await this.ensureGatewayModels();
          await this.gatewayCatalog();
        }
        setTimeout(() => ocrService.prewarm(), 3000).unref?.();
      } catch (_) { /* warming is best effort */ }
      this._warming = false;
    })();
  }

  initializeGatewayClient() {
    if (!this.hasValidKey('GATEWAY')) {
      logger.warn('Custom provider API key not configured');
      return;
    }

    this.model = this.gatewayModelList()[0];
    this.isInitialized = true;
    logger.info('Custom provider initialized successfully', { model: this.model });
    this.warmUp();
  }

  initializeClient() {
    this.isInitialized = false;
    this.client = null;
    // Settings may have changed the provider or its key: learn its models again.
    this._discoveredModels = null;
    this._catalog = null;
    this.provider = this.resolveProvider();

    if (this.provider === 'gateway') {
      this.initializeGatewayClient();
      return;
    }

    // Gemini answers some modes while an OpenRouter-style key handles the rest; scan its models now.
    if (this.hasValidKey('GATEWAY')) this.warmUp();

    const apiKey = config.getApiKey('GEMINI');

    if (!apiKey || apiKey === 'your-api-key-here') {
      logger.warn('Gemini API key not configured', {
        keyExists: !!apiKey,
        isPlaceholder: apiKey === 'your-api-key-here'
      });
      return;
    }

    try {
      this.client = new GoogleGenAI({ apiKey });

      // Use the configured model name (default: gemini-3.5-flash)
      this.model = config.get('llm.gemini.model');
      this.isInitialized = true;

      logger.info('Gemini AI client initialized successfully', {
        model: this.model
      });
    } catch (error) {
      logger.error('Failed to initialize Gemini client', {
        error: error.message
      });
    }
  }

  getGenerationConfig(overrides = {}) {
    const defaults = config.get('llm.gemini.generation') || {};
    const fallback = {
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingBudget: 0 }
    };

    const merged = { ...fallback, ...defaults, ...overrides };
    return Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined && value !== null)
    );
  }

  applyGenerationDefaults(request, overrides = {}) {
    request.generationConfig = this.getGenerationConfig({ ...(request.generationConfig || {}), ...overrides });
    return request;
  }

  extractTextFromCandidates(response) {
    // New @google/genai SDK exposes response.text as a convenience getter.
    if (response && typeof response.text === 'string' && response.text.trim().length > 0) {
      return {
        text: response.text.trim(),
        candidate: response.candidates?.[0] || null,
        finishReason: response.candidates?.[0]?.finishReason || null
      };
    }

    const candidates = Array.isArray(response?.candidates)
      ? response.candidates
      : Array.isArray(response)
        ? response
        : [];

    if (!candidates.length) {
      throw new Error('No candidates in Gemini response');
    }

    const candidateWithText = candidates.find(candidate => {
      const parts = candidate?.content?.parts;
      return Array.isArray(parts) && parts.some(part => typeof part.text === 'string' && part.text.trim().length > 0);
    });

    if (!candidateWithText) {
      const finishReasons = candidates.map(c => c.finishReason || 'unknown').join(', ');
      throw new Error(`No text parts in candidates. Finish reasons: ${finishReasons}`);
    }

    const textParts = candidateWithText.content.parts
      .filter(part => typeof part.text === 'string' && part.text.trim().length > 0)
      .map(part => part.text.trim());

    if (!textParts.length) {
      throw new Error(`Candidate parts missing text after filtering: ${JSON.stringify(candidateWithText)}`);
    }

    const text = textParts.join('\n');

    return {
      text,
      candidate: candidateWithText,
      finishReason: candidateWithText.finishReason || null
    };
  }

  /**
   * Process an image directly with Gemini using the active skill prompt.
   * The image buffer is sent as inlineData alongside a concise instruction.
   * For image-based queries, we include the skill prompt (e.g., DSA) as systemInstruction.
   * @param {Buffer} imageBuffer - PNG/JPEG image bytes
   * @param {string} mimeType - e.g., 'image/png' or 'image/jpeg'
   * @param {string} activeSkill - current skill (e.g. 'dsa')
   * @param {Array} sessionMemory - optional (not required for image)
   * @param {string|null} programmingLanguage - optional language context for skills that need it
   * @returns {Promise<{response: string, metadata: object}>}
   */
  async processImageWithSkill(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check Gemini API key configuration.');
    }

    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
      throw new Error('Invalid image buffer provided to processImageWithSkill');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      // Build system instruction using the skill prompt (with optional language injection)
      const { promptLoader } = require('../../prompt-loader');
      const skillPrompt = promptLoader.getSkillPrompt(activeSkill, programmingLanguage) || '';

      // Build request with text + image parts
      const base64 = imageBuffer.toString('base64');

      const request = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: this.formatImageInstruction(activeSkill, programmingLanguage) },
              { inlineData: { data: base64, mimeType } }
            ]
          }
        ]
      };

      this.applyGenerationDefaults(request);
      this.tagRoute(request, activeSkill);

      if (skillPrompt && skillPrompt.trim().length > 0) {
        request.systemInstruction = { parts: [{ text: skillPrompt }] };
      }

      // Execute with retries/timeout - try alternative method first for network reliability
      let responseText;
      const preferAlternative = !!config.get('llm.gemini.enableFallbackMethod');
      try {
        if (preferAlternative) {
          logger.debug('Attempting alternative HTTPS method first for reliability');
          responseText = await this.executeAlternativeRequest(request);
        } else {
          responseText = await this.executeRequest(request);
        }
      } catch (error) {
        const secondaryLabel = preferAlternative ? 'primary SDK method' : 'alternative HTTPS method';
        logger.warn(`${preferAlternative ? 'Alternative' : 'Primary'} method failed, trying ${secondaryLabel}`, { error: error.message });
        const secondaryFn = preferAlternative ? this.executeRequest.bind(this) : this.executeAlternativeRequest.bind(this);

        try {
          responseText = await secondaryFn(request);
        } catch (secondaryError) {
          logger.error('Both Gemini request methods failed', {
            firstError: error.message,
            secondError: secondaryError.message
          });
          throw secondaryError;
        }
      }

      // Enforce language in code fences if provided
      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(responseText, programmingLanguage)
        : responseText;

      logger.logPerformance('LLM image processing', startTime, {
        activeSkill,
        imageSize: imageBuffer.length,
        responseLength: finalResponse.length,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false, ...this.answerInfo(request),
          isImageAnalysis: true,
          mimeType
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.error('LLM image processing failed', {
        error: error.message,
        activeSkill,
        requestId: this.requestCount
      });

      if (config.get('llm.gemini.fallbackEnabled')) {
        return this.generateFallbackResponse('[image]', activeSkill, error);
      }
      throw error;
    }
  }

  async processImageWithSkillStream(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check Gemini API key configuration.');
    }

    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
      throw new Error('Invalid image buffer provided to processImageWithSkillStream');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      const { promptLoader } = require('../../prompt-loader');
      const skillPrompt = promptLoader.getSkillPrompt(activeSkill, programmingLanguage) || '';
      const base64 = imageBuffer.toString('base64');

      const geminiRequest = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: this.formatImageInstruction(activeSkill, programmingLanguage) },
              { inlineData: { data: base64, mimeType } }
            ]
          }
        ]
      };
      this.applyGenerationDefaults(geminiRequest);
      this.tagRoute(geminiRequest, activeSkill);
      if (skillPrompt && skillPrompt.trim().length > 0) {
        geminiRequest.systemInstruction = { parts: [{ text: skillPrompt }] };
      }

      const fullText = await this.executeStreamingRequest(geminiRequest, (delta) => {
        if (typeof onDelta === 'function' && delta) {
          onDelta(delta);
        }
      });

      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;

      logger.logPerformance('LLM image streaming', startTime, {
        activeSkill,
        imageSize: imageBuffer.length,
        responseLength: finalResponse.length,
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false, ...this.answerInfo(geminiRequest),
          streamed: true,
          isImageAnalysis: true,
          mimeType
        }
      };
    } catch (error) {
      logger.warn('Streaming image analysis failed, falling back to non-streaming', {
        error: error.message,
        requestId: this.requestCount
      });
      return this.processImageWithSkill(imageBuffer, mimeType, activeSkill, sessionMemory, programmingLanguage);
    }
  }

  formatImageInstruction(activeSkill, programmingLanguage) {
    const langNote = programmingLanguage ? ` Use only ${programmingLanguage.toUpperCase()} for any code.` : '';
    return `This is a screenshot of my screen. Read it carefully, find the question or problem shown, and answer it following your instructions. If it only asks what is on the screen, describe it briefly and then answer any question visible. Do not ask which question to answer.${langNote} Follow your answer layout exactly (Pattern, Approach, Code, Complexity) in plain text: no LaTeX, no extra headings, keep it short. The code has no comments at all. If a class or function template is shown, fill it in and do not add main or input code. Put complexity and explanations outside the code block.`;
  }

  async processTextWithSkill(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check Gemini API key configuration.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      logger.info('Processing text with LLM', {
        activeSkill,
        textLength: text.length,
        hasSessionMemory: sessionMemory.length > 0,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      const geminiRequest = this.tagRoute(this.buildGeminiRequest(text, activeSkill, sessionMemory, programmingLanguage), activeSkill);

      const preferAlternative = !!config.get('llm.gemini.enableFallbackMethod');
      let response;
      try {
        if (preferAlternative) {
          logger.debug('Attempting alternative HTTPS method first for text processing');
          response = await this.executeAlternativeRequest(geminiRequest);
        } else {
          response = await this.executeRequest(geminiRequest);
        }
      } catch (error) {
        const secondaryLabel = preferAlternative ? 'primary SDK method' : 'alternative HTTPS method';
        logger.warn(`${preferAlternative ? 'Alternative' : 'Primary'} method failed, trying ${secondaryLabel}`, {
          error: error.message,
          requestId: this.requestCount
        });
        const secondaryFn = preferAlternative ? this.executeRequest.bind(this) : this.executeAlternativeRequest.bind(this);
        try {
          response = await secondaryFn(geminiRequest);
        } catch (secondaryError) {
          logger.error('Both Gemini request methods failed for text processing', {
            firstError: error.message,
            secondError: secondaryError.message,
            requestId: this.requestCount
          });
          throw secondaryError;
        }
      }

      // Enforce language in code fences if programmingLanguage specified
      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(response, programmingLanguage)
        : response;

      logger.logPerformance('LLM text processing', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false, ...this.answerInfo(geminiRequest)
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.error('LLM processing failed', {
        error: error.message,
        activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      if (config.get('llm.gemini.fallbackEnabled')) {
        return this.generateFallbackResponse(text, activeSkill);
      }

      throw error;
    }
  }

  async processTextWithSkillStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check Gemini API key configuration.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      const geminiRequest = this.tagRoute(this.buildGeminiRequest(text, activeSkill, sessionMemory, programmingLanguage), activeSkill);

      const fullText = await this.executeStreamingRequest(geminiRequest, (delta) => {
        if (typeof onDelta === 'function' && delta) {
          onDelta(delta);
        }
      });

      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;

      logger.logPerformance('LLM text streaming', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false, ...this.answerInfo(geminiRequest),
          streamed: true
        }
      };
    } catch (error) {
      logger.warn('Streaming text failed, falling back to non-streaming', {
        error: error.message,
        requestId: this.requestCount
      });
      return this.processTextWithSkill(text, activeSkill, sessionMemory, programmingLanguage);
    }
  }

  async processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory = [], programmingLanguage = null, screenshot = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check Gemini API key configuration.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      logger.info('Processing transcription with intelligent response', {
        activeSkill,
        textLength: text.length,
        hasSessionMemory: sessionMemory.length > 0,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      const geminiRequest = this.tagRoute(this.buildIntelligentTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage), activeSkill);
      await this.attachScreenContext(geminiRequest, screenshot);

      const preferAlternative = !!config.get('llm.gemini.enableFallbackMethod');
      let response;
      try {
        if (preferAlternative) {
          logger.debug('Attempting alternative HTTPS method first for transcription processing');
          response = await this.executeAlternativeRequest(geminiRequest);
        } else {
          response = await this.executeRequest(geminiRequest);
        }
      } catch (error) {
        const secondaryLabel = preferAlternative ? 'primary SDK method' : 'alternative HTTPS method';
        logger.warn(`${preferAlternative ? 'Alternative' : 'Primary'} method failed, trying ${secondaryLabel}`, {
          error: error.message,
          requestId: this.requestCount
        });
        const secondaryFn = preferAlternative ? this.executeRequest.bind(this) : this.executeAlternativeRequest.bind(this);
        try {
          response = await secondaryFn(geminiRequest);
        } catch (secondaryError) {
          logger.error('Both Gemini request methods failed for transcription processing', {
            firstError: error.message,
            secondError: secondaryError.message,
            requestId: this.requestCount
          });
          throw secondaryError;
        }
      }

      // Enforce language in code fences if programmingLanguage specified
      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(response, programmingLanguage)
        : response;

      logger.logPerformance('LLM transcription processing', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false, ...this.answerInfo(geminiRequest),
          isTranscriptionResponse: true
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.error('LLM transcription processing failed', {
        error: error.message,
        activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      if (config.get('llm.gemini.fallbackEnabled')) {
        return this.generateIntelligentFallbackResponse(text, activeSkill);
      }

      throw error;
    }
  }

  /**
   * Normalize all triple-backtick code fences to the selected programming language tag.
   * Does not alter the inner code; only ensures fence language tags are correct.
   */
  /**
   * Add a screenshot to the last user message of a request, so one request
   * carries both what was said and what was on screen.
   * @returns {boolean} true when an image was attached
   */
  attachScreenshot(request, screenshot) {
    try {
      if (!screenshot || !Buffer.isBuffer(screenshot.imageBuffer) || screenshot.imageBuffer.length === 0) return false;
      const contents = request && request.contents;
      if (!Array.isArray(contents) || contents.length === 0) return false;
      const last = contents[contents.length - 1];
      if (!last || last.role !== 'user' || !Array.isArray(last.parts)) return false;
      last.parts.push({
        inlineData: {
          data: screenshot.imageBuffer.toString('base64'),
          mimeType: screenshot.mimeType || 'image/png'
        }
      });
      // The question is in the words; if no model can read the screen, answer without it.
      Object.defineProperty(request, '_imageOptional', { value: true, enumerable: false, writable: true, configurable: true });
      return true;
    } catch (error) {
      logger.warn('Could not attach screenshot to request', { error: error.message });
      return false;
    }
  }

  /**
   * attachScreenshot plus the text OCR reads from it. Auto-routing providers may
   * hand the request to a model that cannot see images and silently ignores the
   * picture; the OCR text lets any model still answer from what is on screen.
   * @returns {Promise<boolean>} true when a screenshot was attached
   */
  async attachScreenContext(request, screenshot) {
    const attached = this.attachScreenshot(request, screenshot);
    if (!attached || !ocrService.enabled() || !ocrService.isInstalled()) return attached;
    try {
      const text = await Promise.race([
        ocrService.recognize(screenshot.imageBuffer),
        new Promise((resolve) => setTimeout(() => resolve(null), 6000))
      ]);
      if (text && text.trim().length > 10) {
        const last = request.contents[request.contents.length - 1];
        last.parts.push({
          text: '\n\n[Text read from the screen with OCR. It may contain mistakes and loses layout and indentation. Use it together with the screenshot.]\n' +
            redactSecrets(limitText(text, 8000))
        });
      }
    } catch (error) {
      logger.warn('OCR of the screen failed; sending the screenshot alone', { error: error.message });
    }
    return attached;
  }

  enforceProgrammingLanguage(text, programmingLanguage) {
    try {
      if (!text || !programmingLanguage) return text;
      const norm = String(programmingLanguage).toLowerCase();
      const fenceTagMap = { cpp: 'cpp', c: 'c', python: 'python', java: 'java', javascript: 'javascript', js: 'javascript' };
      const fenceTag = fenceTagMap[norm] || norm || 'text';

      // Retag only OPENING fences. A closing fence is a bare ``` line; retagging it
      // would open a new block and swallow the text after the code.
      let inFence = false;
      return text.split('\n').map((line) => {
        const m = line.match(/^(\s*)(```|~~~)(.*)$/);
        if (!m) return line;
        if (inFence) {
          if (m[3].trim() === '') inFence = false;
          return line;
        }
        inFence = true;
        const current = m[3].trim();
        if (current.split(/\s+/)[0].toLowerCase() === fenceTag) return line;
        return m[1] + '```' + fenceTag;
      }).join('\n');
    } catch (_) {
      return text;
    }
  }

  buildGeminiRequest(text, activeSkill, sessionMemory, programmingLanguage) {
    // Check if we have the new conversation history format
    const sessionManager = require('../managers/session.manager');

    if (sessionManager && typeof sessionManager.getConversationHistory === 'function') {
      const conversationHistory = sessionManager.getConversationHistory(15);
      const skillContext = sessionManager.getSkillContext(activeSkill, programmingLanguage);
      return this.buildGeminiRequestWithHistory(text, activeSkill, conversationHistory, skillContext, programmingLanguage);
    }

    // Fallback to old method for compatibility - now with programming language support
    const requestComponents = promptLoader.getRequestComponents(
      activeSkill,
      text,
      sessionMemory,
      programmingLanguage
    );

    const request = {
      contents: []
    };

    this.applyGenerationDefaults(request);

    // Use the skill prompt that already has programming language injected
    if (requestComponents.shouldUseModelMemory && requestComponents.skillPrompt) {
      request.systemInstruction = {
        parts: [{ text: requestComponents.skillPrompt }]
      };

      logger.debug('Using language-enhanced system instruction for skill', {
        skill: activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        promptLength: requestComponents.skillPrompt.length,
        requiresProgrammingLanguage: requestComponents.requiresProgrammingLanguage
      });
    }

    request.contents.push({
      role: 'user',
      parts: [{ text: this.formatUserMessage(text, activeSkill) }]
    });

    return request;
  }

  buildGeminiRequestWithHistory(text, activeSkill, conversationHistory, skillContext, programmingLanguage) {
    const request = {
      contents: []
    };

    this.applyGenerationDefaults(request);

    // Use the skill prompt from context (which may already include programming language)
    if (skillContext.skillPrompt) {
      request.systemInstruction = {
        parts: [{ text: skillContext.skillPrompt }]
      };

      logger.debug('Using skill context prompt as system instruction', {
        skill: activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        promptLength: skillContext.skillPrompt.length,
        requiresProgrammingLanguage: skillContext.requiresProgrammingLanguage || false,
        hasLanguageInjection: programmingLanguage && skillContext.requiresProgrammingLanguage
      });
    }

    // Add conversation history (excluding system messages) with validation
    const conversationContents = conversationHistory
      .filter(event => {
        return event.role !== 'system' &&
               event.content &&
               typeof event.content === 'string' &&
               event.content.trim().length > 0;
      })
      .map(event => {
        const content = event.content.trim();
        return {
          role: event.role === 'model' ? 'model' : 'user',
          parts: [{ text: content }]
        };
      });

    // Add the conversation history
    request.contents.push(...conversationContents);

    // Format and validate the current user input
    const formattedMessage = this.formatUserMessage(text, activeSkill);
    if (!formattedMessage || formattedMessage.trim().length === 0) {
      throw new Error('Failed to format user message or message is empty');
    }

    // Add the current user input
    request.contents.push({
      role: 'user',
      parts: [{ text: formattedMessage }]
    });

    logger.debug('Built Gemini request with conversation history', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      historyLength: conversationHistory.length,
      totalContents: request.contents.length,
      hasSystemInstruction: !!request.systemInstruction,
      requiresProgrammingLanguage: skillContext.requiresProgrammingLanguage || false
    });

    return request;
  }

  buildIntelligentTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage) {
    // Validate input text first
    const cleanText = text && typeof text === 'string' ? text.trim() : '';
    if (!cleanText) {
      throw new Error('Empty or invalid transcription text provided to buildIntelligentTranscriptionRequest');
    }

    // Check if we have the new conversation history format
    const sessionManager = require('../managers/session.manager');

    if (sessionManager && typeof sessionManager.getConversationHistory === 'function') {
      const conversationHistory = sessionManager.getConversationHistory(10);
      const skillContext = sessionManager.getSkillContext(activeSkill, programmingLanguage);
      return this.buildIntelligentTranscriptionRequestWithHistory(cleanText, activeSkill, conversationHistory, skillContext, programmingLanguage);
    }

    // Fallback to basic intelligent request
    const request = {
      contents: []
    };

    this.applyGenerationDefaults(request);

    // Add intelligent filtering system instruction
    const intelligentPrompt = this.getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage);
    if (!intelligentPrompt) {
      throw new Error('Failed to generate intelligent transcription prompt');
    }

    request.systemInstruction = {
      parts: [{ text: intelligentPrompt }]
    };

    request.contents.push({
      role: 'user',
      parts: [{ text: cleanText }]
    });

    logger.debug('Built basic intelligent transcription request', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      textLength: cleanText.length,
      hasSystemInstruction: !!request.systemInstruction
    });

    return request;
  }

  buildIntelligentTranscriptionRequestWithHistory(text, activeSkill, conversationHistory, skillContext, programmingLanguage) {
    const request = {
      contents: []
    };

    this.applyGenerationDefaults(request);

  // For chat/transcription messages, DO NOT include the full skill prompt; use only the intelligent filter prompt
  const intelligentPrompt = this.getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage);
  request.systemInstruction = { parts: [{ text: intelligentPrompt }] };

    // Add recent conversation history (excluding system messages) with validation
    const conversationContents = conversationHistory
      .filter(event => {
        // Filter out system messages and ensure content exists and is valid
        return event.role !== 'system' &&
               event.content &&
               typeof event.content === 'string' &&
               event.content.trim().length > 0;
      })
      .slice(-8) // Keep last 8 exchanges for context
      .map(event => {
        const content = event.content.trim();
        if (!content) {
          logger.warn('Empty content found in conversation history', { event });
          return null;
        }
        return {
          role: event.role === 'model' ? 'model' : 'user',
          parts: [{ text: content }]
        };
      })
      .filter(content => content !== null); // Remove any null entries

    // Add the conversation history
    request.contents.push(...conversationContents);

    // Validate and add the current transcription
    const cleanText = text && typeof text === 'string' ? text.trim() : '';
    if (!cleanText) {
      throw new Error('Empty or invalid transcription text provided');
    }

    request.contents.push({
      role: 'user',
      parts: [{ text: cleanText }]
    });

    // Ensure we have at least one content item
    if (request.contents.length === 0) {
      throw new Error('No valid content to send to Gemini API');
    }

    logger.debug('Built intelligent transcription request with conversation history', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      historyLength: conversationHistory.length,
      totalContents: request.contents.length,
      hasSkillPrompt: !!skillContext.skillPrompt,
      cleanTextLength: cleanText.length,
      requiresProgrammingLanguage: skillContext.requiresProgrammingLanguage || false
    });

    return request;
  }

  getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage) {
    // Use the same skill prompt as typed questions and screenshots, so the chosen
    // mode (DSA / Interview) behaves the same however the question arrives.
    const { promptLoader } = require('../../prompt-loader');
    const skillPrompt = promptLoader.getSkillPrompt(activeSkill, programmingLanguage);
    if (skillPrompt && skillPrompt.trim().length > 0) {
      return `${skillPrompt}

## Live input
The message is what the other person just said, as a live transcript. It may contain recognition errors or be only part of a sentence. It can also be a typed follow-up.
If it is not a question or a request you can help with, reply with exactly one short line: "No question detected."
If a screenshot is attached, it shows the screen at the moment the question was asked. Questions like "what is on the screen", "answer this" or "solve this" refer to it: read it, find the question, and answer it directly without asking which one. If the screen is text from OCR, expect small errors and lost indentation. For other questions, use the screenshot only when it helps (a problem statement, code, a diagram) and ignore it when it does not.`;
    }

    let prompt = `# Intelligent Transcription Response System

Assume you are asked a question in ${activeSkill.toUpperCase()} mode. Your job is to intelligently respond to question/message with appropriate brevity.
Assume you are in an interview and you need to perform best in ${activeSkill.toUpperCase()} mode.
Always respond to the point, do not repeat the question or unnecessary information which is not related to ${activeSkill}.`;

    // Add programming language context if provided
    if (programmingLanguage) {
      const lang = String(programmingLanguage).toLowerCase();
      const languageMap = { cpp: 'C++', c: 'C', python: 'Python', java: 'Java', javascript: 'JavaScript', js: 'JavaScript' };
      const fenceTagMap = { cpp: 'cpp', c: 'c', python: 'python', java: 'java', javascript: 'javascript', js: 'javascript' };
      const languageTitle = languageMap[lang] || (lang.charAt(0).toUpperCase() + lang.slice(1));
      const fenceTag = fenceTagMap[lang] || lang || 'text';
      prompt += `\n\nCODING CONTEXT: Respond ONLY in ${languageTitle}. All code blocks must use triple backticks with language tag \`\`\`${fenceTag}\`\`\`. Do not include other languages unless explicitly asked.`;
    }

    prompt += `

## Response Rules:

### If the transcription is casual conversation, greetings, or NOT related to ${activeSkill}:
- Respond with: "Yeah, I'm listening. Ask your question relevant to ${activeSkill}."
- Or similar brief acknowledgments like: "I'm here, what's your ${activeSkill} question?"

### If the transcription IS relevant to ${activeSkill} or is a follow-up question:
- Provide a comprehensive, detailed response
- Use bullet points, examples, and explanations
- Focus on actionable insights and complete answers
- Do not truncate or shorten your response

### Examples of casual/irrelevant messages:
- "Hello", "Hi there", "How are you?"
- "What's the weather like?"
- "I'm just testing this"
- Random conversations not related to ${activeSkill}

### Examples of relevant messages:
- Actual questions about ${activeSkill} concepts
- Follow-up questions to previous responses
- Requests for clarification on ${activeSkill} topics
- Problem-solving requests related to ${activeSkill}

## Response Format:
- Keep responses detailed
- Use bullet points for structured answers
- Be encouraging and helpful
- Stay focused on ${activeSkill}

If the user's input is a coding or DSA problem statement and contains no code, produce a complete, runnable solution in the selected programming language without asking for more details. Always include the final implementation in a properly tagged code block.

Remember: Be intelligent about filtering - only provide detailed responses when the user actually needs help with ${activeSkill}.`;

    return prompt;
  }

  formatUserMessage(text, activeSkill) {
    return `Context: ${activeSkill.toUpperCase()} analysis request\n\nText to analyze:\n${text}`;
  }

  // ── Anthropic provider ────────────────────────────────────────────────
  // The rest of the service builds Gemini-shaped requests. For Anthropic we
  // translate that shape into a Messages API call at the last step, so the
  // prompt building, history and screenshot logic stay shared.

  /** Convert a Gemini-shaped request into an Anthropic Messages payload. */
  toAnthropicRequest(geminiRequest, model, stream, route = null) {
    const system = (geminiRequest.systemInstruction?.parts || [])
      .map(p => p.text)
      .filter(Boolean)
      .join('\n\n');

    const messages = [];
    for (const item of geminiRequest.contents || []) {
      const role = item.role === 'model' ? 'assistant' : 'user';
      const content = [];
      for (const part of item.parts || []) {
        if (typeof part.text === 'string' && part.text.length > 0) {
          content.push({ type: 'text', text: part.text });
        } else if (part.inlineData?.data) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: part.inlineData.mimeType || 'image/png', data: part.inlineData.data }
          });
        }
      }
      if (!content.length) continue;

      // The API needs strictly alternating roles starting with "user".
      const last = messages[messages.length - 1];
      if (last && last.role === role) {
        last.content.push(...content);
      } else if (messages.length > 0 || role === 'user') {
        messages.push({ role, content });
      }
    }

    if (!messages.length) {
      throw new Error('No valid content to send to Anthropic API');
    }

    // Thinking tokens count against max_tokens, so a route can raise the cap.
    const maxTokens = route?.maxTokens || geminiRequest.generationConfig?.maxOutputTokens || config.get('llm.gateway.maxTokens');
    const payload = { model, max_tokens: maxTokens, messages, stream: !!stream };
    if (system) payload.system = system;
    if (route?.effort) payload.output_config = { effort: route.effort };
    return payload;
  }


  /** Build the request body for the gateway's wire format. */
  buildGatewayPayload(geminiRequest, model, stream, route = null, cfg = null) {
    cfg = cfg || this.gatewayConfig();
    return cfg.format === 'openai'
      ? this.toOpenAIRequest(geminiRequest, model, stream, route)
      : this.toAnthropicRequest(geminiRequest, model, stream, route);
  }

  /** Convert a Gemini-shaped request into an OpenAI chat-completions payload. */
  toOpenAIRequest(geminiRequest, model, stream, route = null) {
    const system = (geminiRequest.systemInstruction?.parts || [])
      .map(p => p.text)
      .filter(Boolean)
      .join('\n\n');

    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    for (const item of geminiRequest.contents || []) {
      const role = item.role === 'model' ? 'assistant' : 'user';
      const content = [];
      for (const part of item.parts || []) {
        if (typeof part.text === 'string' && part.text.length > 0) {
          content.push({ type: 'text', text: part.text });
        } else if (part.inlineData?.data) {
          content.push({
            type: 'image_url',
            image_url: { url: `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}` }
          });
        }
      }
      if (!content.length) continue;
      const last = messages[messages.length - 1];
      if (last && last.role === role && Array.isArray(last.content)) {
        last.content.push(...content);
      } else {
        messages.push({ role, content });
      }
    }
    if (!messages.some(m => m.role !== 'system')) {
      throw new Error('No valid content to send to the API');
    }

    const maxTokens = route?.maxTokens || geminiRequest.generationConfig?.maxOutputTokens || config.get('llm.gateway.maxTokens');
    const payload = { model, messages, max_tokens: maxTokens, stream: !!stream };
    // OpenAI-style gateways only know low / medium / high.
    if (route?.effort) payload.reasoning_effort = ['xhigh', 'max'].includes(route.effort) ? 'high' : route.effort;
    return payload;
  }

  _gatewayHttpRequest(payload, onDelta, cfg = null) {
    cfg = cfg || this.gatewayConfig();
    // A stream is dropped if it goes silent for the first-byte timeout; a whole answer gets longer.
    const timeout = cfg.timeout || (payload.stream ? config.get('llm.gateway.firstByteTimeout') : config.get('llm.gateway.timeout'));
    const { baseUrl, format } = cfg;
    // OpenRouter model ids are vendor-prefixed (vendor/model).
    if (cfg.isOpenRouter && payload.model && !payload.model.includes('/')) {
      payload = { ...payload, model: 'anthropic/' + payload.model.replace(/-(\d)-(\d)(?!\d)/, '-$1.$2') };
    }
    const endpoint = new URL(`${baseUrl}${format === 'openai' ? '/chat/completions' : '/messages'}`);
    const lib = endpoint.protocol === 'http:' ? require('http') : require('https');
    const postData = JSON.stringify(payload);
    const agentKey = endpoint.protocol === 'http:' ? '_gatewayHttpAgent' : '_gatewayAgent';
    if (!this[agentKey]) {
      this[agentKey] = new lib.Agent({ keepAlive: true, maxSockets: 4 });
    }

    const options = {
      method: 'POST',
      headers: this.gatewayHeaders(cfg, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': this.getUserAgent()
      }),
      timeout,
      agent: this[agentKey]
    };

    // Pull the text out of one parsed response / stream event, per format.
    const fullText = (json) => format === 'openai'
      ? (json.choices?.[0]?.message?.content ?? '')
      : (json.content || []).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
    const deltaText = (event) => format === 'openai'
      ? (event.choices?.[0]?.delta?.content || '')
      : (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' ? event.delta.text || '' : '');
    const eventError = (event) => {
      if (format === 'openai') return event.error ? new Error(`${event.error.type || 'error'}: ${event.error.message || 'stream error'}`) : null;
      return event.type === 'error' ? new Error(`${event.error?.type || 'error'}: ${event.error?.message || 'stream error'}`) : null;
    };

    return new Promise((resolve, reject) => {
      const req = lib.request(endpoint.href, options, (res) => {
        res.setEncoding('utf8');

        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (c) => { errBody += c; });
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errBody}`)));
          return;
        }

        if (!payload.stream) {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              const text = String(fullText(json) || '').trim();
              if (!text) {
                throw new Error(`No text in response (stop reason: ${json.stop_reason || json.choices?.[0]?.finish_reason || 'unknown'})`);
              }
              resolve(text);
            } catch (e) {
              reject(new Error(`Failed to parse response: ${e.message}`));
            }
          });
          res.on('error', (error) => reject(new Error(`Response error: ${error.message}`)));
          return;
        }

        let text = '';
        let buffer = '';
        let streamError = null;
        res.on('data', (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            try {
              const event = JSON.parse(raw);
              const d = deltaText(event);
              if (d) {
                text += d;
                if (typeof onDelta === 'function') onDelta(d);
              } else {
                streamError = eventError(event) || streamError;
              }
            } catch (_) {
              // Ignore lines that are not complete JSON.
            }
          }
        });
        res.on('end', () => (streamError ? reject(streamError) : resolve(text.trim())));
        res.on('error', (error) => reject(new Error(`Streaming response error: ${error.message}`)));
      });

      req.on('error', (error) => reject(new Error(`Request failed: ${error.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Run a request on the custom provider. Fast by design: a failing model is
   * left behind at once (one retry, only for network trouble), the next model
   * is tried, and models that failed recently are skipped. Images only go to
   * models confirmed to read them; if there are none, OCR text replaces them.
   */
  async executeGatewayRequest(geminiRequest, onDelta = null, route = null, rerolled = false) {
    const maxRetries = config.get('llm.gateway.maxRetries');
    await this.ensureGatewayModels();
    route = route || this.resolveRoute(geminiRequest);
    // A route built before discovery finished still names the default model.
    if (route.provider === 'gateway' && route.isDefault && this._discoveredModels && !(process.env.GATEWAY_MODELS || '').trim()) {
      route = { ...this.gatewayDefaultRoute(), effort: route.effort, maxTokens: route.maxTokens };
    }
    const hasImage = this.requestHasImage(geminiRequest);
    let allModels = [route.model, ...(route.fallbackModels || [])].filter(Boolean);
    if (hasImage) allModels = await this.visionCandidates(allModels);
    // A model that rejects images may still answer text, so image failures are tracked apart.
    const coolKey = (m) => (hasImage ? `${m}|img` : m);
    // Skip models that failed recently; if every model is cooling down, try them all.
    const ready = allModels.filter(m => !this._modelOnCooldown(coolKey(m)));
    const modelsToTry = ready.length ? ready : allModels;
    const stream = typeof onDelta === 'function';
    const healthKey = (m) => `${this.gatewayConfig().baseUrl}|${m}`;
    let lastError = null;

    for (const modelName of modelsToTry) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const payload = this.buildGatewayPayload(geminiRequest, modelName, stream, route);
          const started = Date.now();
          const text = await this._withSlot(() => this._gatewayHttpRequest(payload, onDelta));
          if (!text) throw new Error('Empty response from the API');
          modelHealth.recordLatency(healthKey(modelName), Date.now() - started);
          if (this._cooldowns) this._cooldowns.delete(coolKey(modelName));
          this.markUsed(geminiRequest, 'gateway', modelName);
          return text;
        } catch (error) {
          lastError = error;
          const errorInfo = this.analyzeError(error);
          logger.warn(`Gateway API attempt ${attempt} failed for model ${modelName}`, {
            error: this.shortError(error),
            errorType: errorInfo.type,
            remainingAttempts: maxRetries - attempt
          });

          // Only network trouble or a server error is worth the same model again.
          const transient = errorInfo.isNetworkError || /HTTP 5\d\d/.test(error.message);
          const stuck = /HTTP (502|503|504|529)|overloaded/i.test(error.message);
          if (!transient || stuck || attempt === maxRetries) {
            this._coolDownModel(coolKey(modelName), error.message);
            break;
          }
          await this.delay(400 * attempt + Math.random() * 300);
        }
      }
    }

    // No model could read the image. Read the screen with local OCR and send
    // that text instead; failing that, a spoken question is answered from the
    // words alone, and a bare screenshot has nothing else to go on.
    if (hasImage) {
      const ocrRequest = await this.withOcrText(geminiRequest);
      if (ocrRequest) {
        this.notify('warn', 'No model here can read images. Read the screen with OCR instead.');
        return this.executeGatewayRequest(ocrRequest, onDelta, route, true);
      }
      if (geminiRequest._imageOptional) {
        this.notify('warn', 'No model here can read images. Answered from the words only.');
        const textOnly = this.withoutImages(geminiRequest);
        const lastUser = [...textOnly.contents].reverse().find(c => c.role === 'user');
        if (lastUser) lastUser.parts = [...lastUser.parts, { text: '\n\n[Note: a screenshot of the screen was taken but could not be read. If the question depends on what is on screen, say the screen could not be read and ask the user to type or paste the problem. Do not claim there is no screenshot.]' }];
        return this.executeGatewayRequest(textOnly, onDelta, route, true);
      }
      const noVision = new Error('None of the models can read images, and OCR found no text on the screen. Add a vision-capable model in Settings, or a Gemini key.');
      noVision.noVision = true;
      noVision.originalError = lastError;
      throw noVision;
    }

    // Every known model failed: scan again once for models that work now, then retry.
    if (!rerolled && this.discoveryWanted() && !(process.env.GATEWAY_MODELS || '').trim()) {
      const before = (this._discoveredModels || []).join(',');
      this._cooldowns = new Map();
      await this.ensureGatewayModels(true);
      const after = (this._discoveredModels || []).join(',');
      if (after && after !== before) {
        logger.info('Rerolled gateway models after all failed', { models: after });
        return this.executeGatewayRequest(geminiRequest, onDelta, { ...this.gatewayDefaultRoute(), effort: route.effort, maxTokens: route.maxTokens }, true);
      }
    }

    const finalError = new Error(`API failed after trying ${modelsToTry.join(', ') || 'no models'}: ${lastError?.message}`);
    finalError.errorAnalysis = this.analyzeError(lastError || new Error(''));
    finalError.originalError = lastError;
    throw finalError;
  }

  async testGatewayConnection() {
    const r = await this.testGatewayModel(this.model || this.gatewayModelList()[0]);
    if (r.success) {
      logger.info('Gateway connection test successful', { latency: r.latency, model: r.model });
      return { success: true, response: r.response, latency: r.latency, model: r.model };
    }
    logger.error('Gateway connection test failed', { error: r.error });
    return { success: false, error: r.error };
  }

  async executeRequest(geminiRequest) {
    return this.withProviderFallback(geminiRequest, (route) => this._executeRequestOnRoute(geminiRequest, route));
  }

  async _executeRequestOnRoute(geminiRequest, route) {
    if (route.provider === 'gateway') return this.executeGatewayRequest(geminiRequest, null, route);

    const maxRetries = config.get('llm.gemini.maxRetries');
    const timeout = config.get('llm.gemini.timeout');
    const primaryModel = route.model;
    const fallbackModels = route.fallbackModels || [];
    const modelsToTry = [primaryModel, ...fallbackModels];

    logger.debug('Executing Gemini request', {
      hasModel: !!this.model,
      hasClient: !!this.client,
      requestKeys: Object.keys(geminiRequest),
      timeout,
      maxRetries,
      modelsToTry,
      nodeVersion: process.version,
      platform: process.platform
    });

    let lastError = null;

    for (const modelName of modelsToTry) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Request timeout')), timeout)
          );

          logger.debug(`Gemini API attempt ${attempt} starting with model ${modelName}`, {
            timestamp: new Date().toISOString(),
            timeout,
            model: modelName
          });

          const requestPromise = this.getGeminiClient().models.generateContent({
            model: modelName,
            contents: geminiRequest.contents,
            config: geminiRequest.generationConfig,
            systemInstruction: geminiRequest.systemInstruction
          });
          const result = await Promise.race([requestPromise, timeoutPromise]);

          if (!result) {
            throw new Error('Empty response from Gemini API');
          }

          const { text, finishReason } = this.extractTextFromCandidates(result);

          if (finishReason === 'MAX_TOKENS') {
            logger.warn('Gemini response reached max tokens limit', {
              attempt,
              finishReason,
              model: modelName
            });
          }

          logger.debug('Gemini API request successful', {
            attempt,
            model: modelName,
            responseLength: text.length,
            finishReason
          });

          this.markUsed(geminiRequest, 'gemini', modelName);
          return text;
        } catch (error) {
          const errorInfo = this.analyzeError(error);
          lastError = error;

          // Enhanced error logging for fetch failures
          if (errorInfo.type === 'NETWORK_ERROR') {
            logger.error('Network error details', {
              attempt,
              model: modelName,
              errorMessage: error.message,
              errorStack: error.stack,
              errorName: error.name,
              nodeEnv: process.env.NODE_ENV,
              electronVersion: process.versions.electron,
              chromeVersion: process.versions.chrome,
              nodeVersion: process.versions.node,
              userAgent: this.getUserAgent()
            });
          }

          logger.warn(`Gemini API attempt ${attempt} failed for model ${modelName}`, {
            error: error.message,
            errorType: errorInfo.type,
            isNetworkError: errorInfo.isNetworkError,
            suggestedAction: errorInfo.suggestedAction,
            remainingAttempts: maxRetries - attempt,
            model: modelName
          });

          // For model-unavailable / overloaded / rate-limit errors, move to
          // the next fallback model immediately instead of burning all retries.
          const isModelUnavailable = errorInfo.type === 'RATE_LIMIT_ERROR' ||
            error.message.includes('503') ||
            error.message.includes('UNAVAILABLE') ||
            error.message.includes('high demand');

          if (isModelUnavailable && modelName !== modelsToTry[modelsToTry.length - 1]) {
            logger.info(`Switching to fallback model after ${modelName} unavailable`, {
              model: modelName,
              error: error.message
            });
            break; // exit retry loop for this model and try next model
          }

          if (attempt === maxRetries) {
            break; // exit retry loop for this model and try next model
          }

          // Use exponential backoff with jitter for network errors
          const baseDelay = errorInfo.isNetworkError ? 2500 : 1500;
          const delay = baseDelay * attempt + Math.random() * 1000;

          logger.debug(`Waiting ${delay}ms before retry ${attempt + 1}`, {
            baseDelay,
            isNetworkError: errorInfo.isNetworkError,
            model: modelName
          });

          await this.delay(delay);
        }
      }
    }

    const finalErrorInfo = this.analyzeError(lastError);
    const finalError = new Error(`Gemini API failed after trying ${modelsToTry.join(', ')}: ${lastError?.message}`);
    finalError.errorAnalysis = finalErrorInfo;
    finalError.originalError = lastError;
    throw finalError;
  }

  /**
   * Streaming sibling of processTranscriptionWithIntelligentResponse. Emits
   * incremental text via onDelta so the UI can render the answer as it is
   * generated (much faster perceived latency). Returns the same
   * {response, metadata} shape. Falls back to the non-streaming path on any
   * streaming failure so reliability is never worse than before.
   */
  async processTranscriptionWithIntelligentResponseStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null, screenshot = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check Gemini API key configuration.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      const geminiRequest = this.tagRoute(this.buildIntelligentTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage), activeSkill);
      const withScreenshot = await this.attachScreenContext(geminiRequest, screenshot);

      const fullText = await this.executeStreamingRequest(geminiRequest, (delta) => {
        if (typeof onDelta === 'function' && delta) {
          onDelta(delta);
        }
      });

      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;

      logger.logPerformance('LLM transcription streaming', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        withScreenshot,
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false, ...this.answerInfo(geminiRequest),
          streamed: true,
          isTranscriptionResponse: true,
          withScreenshot
        }
      };
    } catch (error) {
      logger.warn('Streaming transcription failed, falling back to non-streaming', {
        error: error.message,
        requestId: this.requestCount
      });
      // Non-streaming path returns the same shape; the caller renders it as a
      // single final response.
      return this.processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory, programmingLanguage, screenshot);
    }
  }

  /** Safely pull the text delta out of a streamed Gemini chunk. */
  _extractChunkText(chunk) {
    try {
      const t = chunk && chunk.text;
      if (typeof t === 'string') {
        return t;
      }
    } catch (_) {
      // `.text` getter can throw on non-text parts; fall through to manual read.
    }
    try {
      const parts = (chunk && chunk.candidates && chunk.candidates[0] &&
        chunk.candidates[0].content && chunk.candidates[0].content.parts) || [];
      return parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
    } catch (_) {
      return '';
    }
  }

  /**
   * Run a streaming Gemini request with the same model-fallback + retry policy
   * as executeRequest. Accumulates and returns the full text; invokes onDelta
   * for each chunk.
   */
  async executeStreamingRequest(geminiRequest, onDelta) {
    // Once text has reached the user, switching provider would repeat it, so
    // only fall back across providers while nothing has been streamed yet.
    let streamed = false;
    const tracked = (delta) => {
      streamed = true;
      if (typeof onDelta === 'function') onDelta(delta);
    };
    return this.withProviderFallback(
      geminiRequest,
      (route) => this._executeStreamingOnRoute(geminiRequest, tracked, route),
      () => !streamed
    );
  }

  async _executeStreamingOnRoute(geminiRequest, onDelta, route) {
    if (route.provider === 'gateway') {
      return this.executeGatewayRequest(geminiRequest, onDelta || (() => {}), route);
    }

    const maxRetries = config.get('llm.gemini.maxRetries');
    const apiKey = config.getApiKey('GEMINI');
    const primaryModel = route.model;
    const fallbackModels = route.fallbackModels || [];
    const modelsToTry = [primaryModel, ...fallbackModels];

    let lastError = null;

    for (const modelName of modelsToTry) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const fullText = await this._streamRequestForModel(geminiRequest, modelName, apiKey, onDelta);

          if (!fullText) {
            throw new Error('Empty streamed response from Gemini API');
          }

          logger.debug('Gemini streaming request successful', {
            attempt,
            model: modelName,
            responseLength: fullText.length
          });

          this.markUsed(geminiRequest, 'gemini', modelName);
          return fullText;
        } catch (error) {
          const errorInfo = this.analyzeError(error);
          lastError = error;

          logger.warn(`Gemini streaming attempt ${attempt} failed for model ${modelName}`, {
            error: error.message,
            errorType: errorInfo.type,
            remainingAttempts: maxRetries - attempt,
            model: modelName
          });

          const isModelUnavailable = errorInfo.type === 'RATE_LIMIT_ERROR' ||
            error.message.includes('503') ||
            error.message.includes('UNAVAILABLE') ||
            error.message.includes('high demand');

          if (isModelUnavailable && modelName !== modelsToTry[modelsToTry.length - 1]) {
            break; // try next fallback model
          }

          if (attempt === maxRetries) {
            break;
          }

          const baseDelay = errorInfo.isNetworkError ? 2500 : 1500;
          const delay = baseDelay * attempt + Math.random() * 1000;
          await this.delay(delay);
        }
      }
    }

    throw lastError || new Error('Gemini streaming request failed');
  }

  _streamRequestForModel(geminiRequest, modelName, apiKey, onDelta) {
    const https = require('https');
    const timeout = config.get('llm.gemini.timeout');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse`;
    const postData = JSON.stringify(geminiRequest);
    // One shared keep-alive agent: later answers reuse the TLS connection
    // instead of paying a fresh handshake every time.
    if (!this._streamAgent) {
      this._streamAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });
    }
    const agent = this._streamAgent;

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': this.getUserAgent()
      },
      timeout,
      agent
    };

    return new Promise((resolve, reject) => {
      const req = https.request(url, options, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (c) => { errBody += c; });
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errBody}`)));
          return;
        }

        let fullText = '';
        let buffer = '';

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) {
              continue;
            }
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') {
              continue;
            }
            try {
              const json = JSON.parse(payload);
              const piece = this._extractChunkText(json);
              if (piece) {
                fullText += piece;
                if (typeof onDelta === 'function') {
                  onDelta(piece);
                }
              }
            } catch (_) {
              // Partial JSON across chunk boundaries is rare with line framing;
              // skip anything that doesn't parse cleanly.
            }
          }
        });

        res.on('end', () => resolve(fullText.trim()));
        res.on('error', (error) => reject(new Error(`Streaming response error: ${error.message}`)));
      });

      req.on('error', (error) => reject(new Error(`Streaming request failed: ${error.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Streaming request timeout'));
      });

      req.write(postData);
      req.end();
    });
  }

  async performPreflightCheck() {
    // Quick connectivity check
    try {
      const startTime = Date.now();
      await this.testNetworkConnection({
        host: 'generativelanguage.googleapis.com',
        port: 443,
        name: 'Gemini API Endpoint'
      });
      const latency = Date.now() - startTime;

      logger.debug('Preflight check passed', { latency });
    } catch (error) {
      logger.warn('Preflight check failed', {
        error: error.message,
        suggestion: 'Network connectivity issue detected before API call'
      });
      // Don't throw here - let the actual API call fail with more detail
    }
  }

  getUserAgent() {
    try {
      // Try to get user agent from Electron if available
      if (typeof navigator !== 'undefined' && navigator.userAgent) {
        return navigator.userAgent;
      }
      return `Node.js/${process.version} (${process.platform}; ${process.arch})`;
    } catch {
      return 'Unknown';
    }
  }

  analyzeError(error) {
    const errorMessage = error.message.toLowerCase();

    // Network connectivity errors
    if (errorMessage.includes('fetch failed') ||
        errorMessage.includes('network error') ||
        errorMessage.includes('enotfound') ||
        errorMessage.includes('econnrefused') ||
        errorMessage.includes('timeout')) {
      return {
        type: 'NETWORK_ERROR',
        isNetworkError: true,
        suggestedAction: 'Check internet connection and firewall settings'
      };
    }

    // API key errors
    if (errorMessage.includes('unauthorized') ||
        errorMessage.includes('invalid api key') ||
        errorMessage.includes('authentication_error') ||
        errorMessage.includes('permission_error') ||
        errorMessage.includes('http 401') ||
        errorMessage.includes('forbidden')) {
      return {
        type: 'AUTH_ERROR',
        isNetworkError: false,
        suggestedAction: 'Verify API key configuration'
      };
    }

    // Rate limiting
    if (errorMessage.includes('quota') ||
        errorMessage.includes('rate limit') ||
        errorMessage.includes('rate_limit_error') ||
        errorMessage.includes('http 429') ||
        errorMessage.includes('too many requests')) {
      return {
        type: 'RATE_LIMIT_ERROR',
        isNetworkError: false,
        suggestedAction: 'Wait before retrying or check API quota'
      };
    }

    // Timeout errors
    if (errorMessage.includes('request timeout') || errorMessage.includes('etimedout')) {
      return {
        type: 'TIMEOUT_ERROR',
        isNetworkError: true,
        suggestedAction: 'Check network latency or increase timeout'
      };
    }

    return {
      type: 'UNKNOWN_ERROR',
      isNetworkError: false,
      suggestedAction: 'Check logs for more details'
    };
  }

  async checkNetworkConnectivity() {
    const connectivityTests = [
      { host: 'google.com', port: 443, name: 'Google (HTTPS)' },
      { host: 'generativelanguage.googleapis.com', port: 443, name: 'Gemini API Endpoint' }
    ];

    const results = await Promise.allSettled(
      connectivityTests.map(test => this.testNetworkConnection(test))
    );

    const connectivity = {
      timestamp: new Date().toISOString(),
      tests: results.map((result, index) => ({
        ...connectivityTests[index],
        success: result.status === 'fulfilled' && result.value,
        error: result.status === 'rejected' ? result.reason.message : null
      }))
    };

    logger.info('Network connectivity check completed', connectivity);
    return connectivity;
  }

  async testNetworkConnection({ host, port, name }) {
    return new Promise((resolve, reject) => {
      const net = require('net');
      const socket = new net.Socket();

      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timeout to ${host}:${port}`));
      }, 5000);

      socket.on('connect', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });

      socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`Connection failed to ${host}:${port}: ${error.message}`));
      });

      socket.connect(port, host);
    });
  }

  generateFallbackResponse(text, activeSkill, error = null) {
    logger.info('Generating fallback response', { activeSkill });
    if (error && error.noVision) {
      return { response: error.message, metadata: { skill: activeSkill, processingTime: 0, requestId: this.requestCount, usedFallback: true } };
    }

    const fallbackResponses = {
      'dsa': 'This appears to be a data structures and algorithms problem. Consider breaking it down into smaller components and identifying the appropriate algorithm or data structure to use.',
      'interview': 'This looks like an interview question. Answer directly, give one concrete example or trade-off, and keep it short enough to say out loud.',
      'default': 'I can help analyze this content. Please ensure your Gemini API key is properly configured for detailed analysis.'
    };

    const response = fallbackResponses[activeSkill] || fallbackResponses.default;

    return {
      response,
      metadata: {
        skill: activeSkill,
        processingTime: 0,
        requestId: this.requestCount,
        usedFallback: true
      }
    };
  }

  generateIntelligentFallbackResponse(text, activeSkill) {
    logger.info('Generating intelligent fallback response for transcription', { activeSkill });

    // Simple heuristic to determine if message seems skill-related
    const skillKeywords = {
      'dsa': ['algorithm', 'data structure', 'array', 'tree', 'graph', 'sort', 'search', 'complexity', 'big o'],
      'interview': ['interview', 'experience', 'situation', 'leadership', 'conflict', 'team', 'design', 'scalability', 'database', 'architecture', 'code', 'function', 'deploy', 'docker', 'model', 'negotiate', 'salary']
    };

    const textLower = text.toLowerCase();
    const relevantKeywords = skillKeywords[activeSkill] || [];
    const hasRelevantKeywords = relevantKeywords.some(keyword => textLower.includes(keyword));

    // Check for question indicators
    const questionIndicators = ['how', 'what', 'why', 'when', 'where', 'can you', 'could you', 'should i', '?'];
    const seemsLikeQuestion = questionIndicators.some(indicator => textLower.includes(indicator));

    let response;
    if (hasRelevantKeywords || seemsLikeQuestion) {
      response = `I'm having trouble processing that right now, but it sounds like a ${activeSkill} question. Could you rephrase or ask more specifically about what you need help with?`;
    } else {
      response = `Yeah, I'm listening. Ask your question relevant to ${activeSkill}.`;
    }

    return {
      response,
      metadata: {
        skill: activeSkill,
        processingTime: 0,
        requestId: this.requestCount,
        usedFallback: true,
        isTranscriptionResponse: true
      }
    };
  }

  async testConnection() {
    if (!this.isInitialized) {
      return { success: false, error: 'Service not initialized' };
    }

    if (this.provider === 'gateway') return this.testGatewayConnection();

    try {
      // First check network connectivity
      const networkCheck = await this.checkNetworkConnectivity();
      const hasNetworkIssues = networkCheck.tests.some(test => !test.success);

      if (hasNetworkIssues) {
        logger.warn('Network connectivity issues detected', networkCheck);
      }

      const generationConfig = this.getGenerationConfig({ temperature: 0, maxOutputTokens: 64 });
      const fallbackModels = config.get('llm.gemini.fallbackModels') || [];
      const modelsToTry = [this.model, ...fallbackModels];

      let lastError = null;
      let result = null;
      let usedModel = null;

      for (const modelName of modelsToTry) {
        try {
          const startTime = Date.now();
          result = await this.client.models.generateContent({
            model: modelName,
            contents: 'Test connection. Please respond with "OK".',
            config: generationConfig
          });
          usedModel = modelName;
          const latency = Date.now() - startTime;
          const { text } = this.extractTextFromCandidates(result);

          logger.info('Connection test successful', {
            response: text,
            latency,
            model: usedModel,
            networkCheck: hasNetworkIssues ? 'issues_detected' : 'healthy'
          });

          return {
            success: true,
            response: text,
            latency,
            model: usedModel,
            networkConnectivity: networkCheck
          };
        } catch (error) {
          lastError = error;
          logger.warn(`Connection test failed for model ${modelName}`, {
            error: error.message,
            model: modelName
          });

          const isModelUnavailable = error.message.includes('503') ||
            error.message.includes('UNAVAILABLE') ||
            error.message.includes('high demand') ||
            error.message.includes('quota') ||
            error.message.includes('rate limit');

          if (!isModelUnavailable && modelName === this.model) {
            // Primary model failed for a non-availability reason; don't hide it
            break;
          }
        }
      }

      throw lastError || new Error('Connection test failed on all models');
    } catch (error) {
      const errorAnalysis = this.analyzeError(error);
      logger.error('Connection test failed', {
        error: error.message,
        errorAnalysis
      });

      // Map raw SDK errors to user-friendly messages. The wizard only
      // surfaces `error`, so any raw SDK error string would land in the
      // UI verbatim.
      const friendlyError = this._friendlyTestError(error, errorAnalysis);

      return {
        success: false,
        error: friendlyError,
        errorType: errorAnalysis?.type || 'UNKNOWN',
        errorAnalysis,
        networkConnectivity: await this.checkNetworkConnectivity().catch(() => null)
      };
    }
  }

  /**
   * Translate raw SDK / network errors into something a user can act on.
   */
  _friendlyTestError(error, analysis) {
    const type = analysis?.type;
    const raw = (error?.message || '').toLowerCase();

    if (this.provider === 'gateway') {
      if (type === 'NETWORK_ERROR') return 'Cannot reach the API server. Check your internet connection, firewall, or VPN settings.';
      if (type === 'AUTH_ERROR') return 'Invalid API key or insufficient permissions. Check the API key and credential kind in Settings.';
      if (type === 'RATE_LIMIT_ERROR') return 'Rate limit exceeded. Wait a moment or check your plan limits.';
      if (raw.includes('not_found_error') || raw.includes('http 404')) return 'The configured model is unavailable. Try a different model in Settings.';
      if (raw.includes('overloaded') || raw.includes('http 529') || raw.includes('http 503')) return 'The AI provider is overloaded right now. Please wait a moment and try again.';
      return (error?.message || 'Connection failed');
    }

    if (type === 'NETWORK_ERROR' || raw.includes('fetch failed') || raw.includes('enotfound')) {
      return 'Cannot reach Google servers. Check your internet connection, firewall, or VPN settings.';
    }
    if (type === 'AUTH_ERROR' || raw.includes('api key') || raw.includes('401') || raw.includes('403')) {
      return 'Invalid API key or insufficient permissions. Double-check the key at aistudio.google.com/apikey.';
    }
    if (type === 'RATE_LIMIT_ERROR' || raw.includes('429') || raw.includes('quota')) {
      return 'Rate limit or quota exceeded. Wait a moment or check your Google Cloud billing.';
    }
    if (type === 'TIMEOUT_ERROR') {
      return 'Request timed out. The Google API may be slow or unreachable right now.';
    }
    if (type === 'MODEL_ERROR' || raw.includes('model') || raw.includes('404')) {
      return 'The configured Gemini model is unavailable. Try a different model in Settings.';
    }
    if (raw.includes('503') || raw.includes('unavailable') || raw.includes('high demand')) {
      return 'Gemini is experiencing high demand. Please wait a moment and try again.';
    }
    // Fall back to a stripped-down raw message (no SDK prefix noise)
    return (error?.message || 'Connection failed').replace(/^\[(GoogleGenerativeAI|GoogleGenAI) Error\]:\s*/i, '');
  }

  updateApiKey(newApiKey) {
    process.env.GEMINI_API_KEY = newApiKey;
    this.isInitialized = false;
    this.initializeClient();

    logger.info('API key updated and client reinitialized');
  }

  getStats() {
    return {
      isInitialized: this.isInitialized,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      successRate: this.requestCount > 0 ? ((this.requestCount - this.errorCount) / this.requestCount) * 100 : 0,
      provider: this.provider,
      // Callers (the panel's model label) read config.model, so report the
      // model actually in use.
      config: { ...config.get(`llm.${this.provider}`), model: this.model || config.get(`llm.${this.provider}.model`) }
    };
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async executeAlternativeRequest(geminiRequest) {
    return this.withProviderFallback(geminiRequest, (route) => this._executeAlternativeOnRoute(geminiRequest, route));
  }

  async _executeAlternativeOnRoute(geminiRequest, route) {
    if (route.provider === 'gateway') return this.executeGatewayRequest(geminiRequest, null, route);

    const https = require('https');
    const apiKey = config.getApiKey('GEMINI');
    const primaryModel = route.model;
    const fallbackModels = route.fallbackModels || [];
    const modelsToTry = [primaryModel, ...fallbackModels];

    logger.info('Using alternative HTTPS request method', { modelsToTry });

    let lastError = null;

    for (const modelName of modelsToTry) {
      try {
        const result = await this._executeAlternativeRequestForModel(geminiRequest, modelName, apiKey);
        this.markUsed(geminiRequest, 'gemini', modelName);
        return result;
      } catch (error) {
        lastError = error;
        logger.warn(`Alternative HTTPS request failed for model ${modelName}`, {
          error: error.message,
          model: modelName
        });

        const isModelUnavailable = error.message.includes('503') ||
          error.message.includes('UNAVAILABLE') ||
          error.message.includes('high demand');

        if (!isModelUnavailable && modelName === primaryModel) {
          break;
        }
      }
    }

    throw lastError || new Error('Alternative HTTPS request failed for all models');
  }

  async _executeAlternativeRequestForModel(geminiRequest, modelName, apiKey) {
    const https = require('https');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

    const postData = JSON.stringify(geminiRequest);

    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': this.getUserAgent()
      },
      timeout: config.get('llm.gemini.timeout'),
      agent
    };

    return new Promise((resolve, reject) => {
      const req = https.request(url, options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
              return;
            }

            const response = JSON.parse(data);

            logger.debug('Alternative request response structure', {
              hasResponse: !!response,
              hasCandidates: !!response.candidates,
              candidatesLength: response.candidates?.length,
              responseKeys: Object.keys(response || {}),
              firstCandidateKeys: response.candidates?.[0] ? Object.keys(response.candidates[0]) : []
            });

            const { text, finishReason } = this.extractTextFromCandidates(response);

            if (finishReason === 'MAX_TOKENS') {
              logger.warn('Gemini alternative response reached max tokens limit', {
                finishReason
              });
            }

            logger.info('Alternative request successful', {
              responseLength: text.length,
              statusCode: res.statusCode,
              finishReason
            });

            resolve(text.trim());
          } catch (parseError) {
            logger.error('Failed to parse alternative response', {
              error: parseError.message,
              rawResponse: data.substring(0, 500),
              statusCode: res.statusCode
            });
            reject(new Error(`Failed to parse response: ${parseError.message}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Alternative request failed: ${error.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Alternative request timeout'));
      });

      req.write(postData);
      req.end();
    });
  }
}

module.exports = new LLMService();