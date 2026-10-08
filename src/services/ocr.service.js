const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { appDataDir } = require('../core/paths');

/**
 * Local OCR for screenshots, used when no available AI model can read images.
 * tesseract.js runs offline in a worker; the English language data (about
 * 2 MB) is downloaded once, either ahead of time (setup wizard, `npm run
 * setup-ocr`) or on first use, into the app data folder.
 */
const LANG = 'eng';
// Stored uncompressed: tesseract.js reads `<cachePath>/<lang>.traineddata` itself,
// which works in Electron too (its langPath handling only fetches over the network there).
const LANG_FILE = `${LANG}.traineddata`;
const LANG_URL = `https://tessdata.projectnaptha.com/4.0.0_fast/${LANG}.traineddata.gz`;
const IDLE_MS = 60 * 1000;
const RECOGNIZE_TIMEOUT_MS = 30 * 1000;

function defaultDataDir() {
  return process.env.OCR_DATA_DIR || path.join(appDataDir(), 'ocr');
}

class OcrService {
  constructor() {
    this.worker = null;
    this.starting = null;
    this.idleTimer = null;
  }

  dataDir() {
    return defaultDataDir();
  }

  /** Start the worker ahead of the first screenshot (only if the data is already installed). */
  async prewarm() {
    if (!this.enabled() || !this.isInstalled()) return;
    try { await this._getWorker(); this._touchIdle(); } catch (_) { /* retried on first use */ }
  }

  langPath() {
    return path.join(this.dataDir(), LANG_FILE);
  }

  isInstalled() {
    try {
      return fs.statSync(this.langPath()).size > 1024 * 1024;
    } catch (_) {
      return false;
    }
  }

  enabled() {
    return (process.env.JOBAI_OCR_FALLBACK || 'true').trim().toLowerCase() !== 'false';
  }

  /** Download the language data once. onProgress receives plain text lines. */
  async install(onProgress = () => {}) {
    if (this.isInstalled()) {
      onProgress('OCR language data already installed.');
      return { ok: true, path: this.langPath(), alreadyInstalled: true };
    }
    fs.mkdirSync(this.dataDir(), { recursive: true });
    const target = this.langPath();
    const tmp = target + '.part';
    onProgress(`Downloading English OCR data (about 2 MB) to ${this.dataDir()}`);
    try {
      await this._download(LANG_URL, tmp, (pct) => onProgress(`Downloading… ${pct}%`));
      fs.renameSync(tmp, target);
      onProgress('Done.');
      return { ok: true, path: target };
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean */ }
      return { ok: false, message: error.message };
    }
  }

  _download(url, file, onPct, redirects = 0) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 4) {
          res.resume();
          return resolve(this._download(new URL(res.headers.location, url).href, file, onPct, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download failed (HTTP ${res.statusCode})`));
        }
        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        let lastPct = -1;
        const out = fs.createWriteStream(file);
        const gunzip = zlib.createGunzip();
        res.on('data', (chunk) => {
          got += chunk.length;
          if (total) {
            const pct = Math.floor((got / total) * 100);
            if (pct >= lastPct + 20) { lastPct = pct; onPct(pct); }
          }
        });
        res.pipe(gunzip).pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
        gunzip.on('error', reject);
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('Download timed out')));
      req.on('error', reject);
    });
  }

  async _getWorker() {
    if (this.worker) return this.worker;
    if (!this.starting) {
      this.starting = (async () => {
        if (!this.isInstalled()) {
          const r = await this.install();
          if (!r.ok) throw new Error(`OCR data is not installed and could not be downloaded: ${r.message}`);
        }
        const { createWorker } = require('tesseract.js');
        const worker = await createWorker(LANG, 1, {
          cachePath: this.dataDir(),
          gzip: false,
          logger: () => {}
        });
        this.worker = worker;
        return worker;
      })().finally(() => { this.starting = null; });
    }
    return this.starting;
  }

  _touchIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.shutdown(), IDLE_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  /** Read the text in an image buffer. Resolves to '' when nothing is found. */
  async recognize(imageBuffer) {
    if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) return '';
    const worker = await this._getWorker();
    let timer;
    try {
      const result = await Promise.race([
        worker.recognize(imageBuffer),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('OCR timed out')), RECOGNIZE_TIMEOUT_MS); })
      ]);
      return String((result && result.data && result.data.text) || '').replace(/\n{3,}/g, '\n\n').trim();
    } catch (error) {
      await this.shutdown(); // a stuck worker is replaced on the next call
      throw error;
    } finally {
      clearTimeout(timer);
      this._touchIdle();
    }
  }

  async shutdown() {
    clearTimeout(this.idleTimer);
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      try { await worker.terminate(); } catch (_) { /* already gone */ }
    }
  }
}

module.exports = new OcrService();
