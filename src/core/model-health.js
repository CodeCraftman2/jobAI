const fs = require('fs');
const path = require('path');
const { appDataDir } = require('./paths');

/**
 * What the app has learned about AI models, kept between launches so it does
 * not have to re-learn it (and pay for it) every start:
 *   - which models can read images (found by a live test, not by name),
 *   - how fast each model answers,
 *   - the models found by discovery for a provider.
 * Holds model names, timings and flags only: no keys, prompts or answers.
 */
const VISION_YES_TTL = 7 * 24 * 3600 * 1000;
const VISION_NO_TTL = 24 * 3600 * 1000;
const DISCOVERED_TTL = 6 * 3600 * 1000;

class ModelHealth {
  constructor() {
    this.data = null;
    this.timer = null;
  }

  file() {
    return path.join(appDataDir(), 'model-health.json');
  }

  _load() {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
    } catch (_) {
      this.data = {};
    }
    this.data.vision = this.data.vision || {};
    this.data.latency = this.data.latency || {};
    this.data.discovered = this.data.discovered || {};
    return this.data;
  }

  /** Forget the in-memory copy (tests, or after the data folder changed). */
  reset() {
    clearTimeout(this.timer);
    this.timer = null;
    this.data = null;
  }

  _save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 500);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    if (!this.data) return;
    try {
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      fs.writeFileSync(this.file() + '.tmp', JSON.stringify(this.data), 'utf8');
      fs.renameSync(this.file() + '.tmp', this.file());
    } catch (_) { /* a missing cache only costs a re-test */ }
  }

  /** true / false when known and fresh, undefined when it has to be tested. */
  getVision(key) {
    const entry = this._load().vision[key];
    if (!entry) return undefined;
    const ttl = entry.ok ? VISION_YES_TTL : VISION_NO_TTL;
    return Date.now() - entry.at < ttl ? entry.ok : undefined;
  }

  setVision(key, ok) {
    this._load().vision[key] = { ok: !!ok, at: Date.now() };
    this._save();
  }

  /** Exponential moving average of how long answers take. */
  recordLatency(key, ms) {
    const latency = this._load().latency;
    const prev = latency[key];
    latency[key] = prev ? Math.round(prev * 0.7 + ms * 0.3) : Math.round(ms);
    this._save();
  }

  latency(key) {
    return this._load().latency[key];
  }

  getDiscovered(baseUrl) {
    const entry = this._load().discovered[baseUrl];
    return entry && Date.now() - entry.at < DISCOVERED_TTL ? entry.models : null;
  }

  setDiscovered(baseUrl, models) {
    this._load().discovered[baseUrl] = { models, at: Date.now() };
    this._save();
  }
}

module.exports = new ModelHealth();
