const fs = require('fs');
const path = require('path');

/**
 * API keys live in the operating system's credential store, not in .env.
 *
 * Electron's safeStorage encrypts with the OS keychain: Windows DPAPI, macOS
 * Keychain, Linux libsecret (GNOME Keyring / KWallet). Only the encrypted
 * values are written to disk (secrets.enc.json in the app data folder), and
 * only the same OS user on the same machine can decrypt them.
 *
 * Where no keychain is available (a Linux box without a secret service),
 * available() is false and callers keep the key in .env as before.
 */
const SECRET_KEYS = ['GEMINI_API_KEY', 'GATEWAY_API_KEY', 'AZURE_SPEECH_KEY'];

class SecureStore {
  constructor() {
    this.file = null;
    this.safeStorage = null;
  }

  /** Call once the app is ready, with the folder to keep secrets.enc.json in. */
  init(dir, safeStorage) {
    this.file = path.join(dir, 'secrets.enc.json');
    this.safeStorage = safeStorage || null;
    return this.available();
  }

  isSecret(key) {
    return SECRET_KEYS.includes(key);
  }

  available() {
    try {
      return !!(this.file && this.safeStorage && this.safeStorage.isEncryptionAvailable());
    } catch (_) {
      return false;
    }
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch (_) {
      return {};
    }
  }

  _write(data) {
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(key) {
    if (!this.available()) return '';
    const stored = this._read()[key];
    if (!stored) return '';
    try {
      return this.safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch (_) {
      return ''; // saved under another OS user or machine; treated as not set
    }
  }

  has(key) {
    return !!this.get(key);
  }

  /** Save (or, with an empty value, remove) one secret. Returns false if it could not be stored. */
  set(key, value) {
    if (!this.available() || !this.isSecret(key)) return false;
    const data = this._read();
    const text = String(value || '').trim();
    if (text) data[key] = this.safeStorage.encryptString(text).toString('base64');
    else delete data[key];
    try {
      this._write(data);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Put every stored secret into process.env, so the rest of the app reads them as before. */
  loadIntoEnv() {
    const loaded = [];
    for (const key of SECRET_KEYS) {
      const value = this.get(key);
      if (value) {
        process.env[key] = value;
        loaded.push(key);
      }
    }
    return loaded;
  }
}

module.exports = new SecureStore();
module.exports.SECRET_KEYS = SECRET_KEYS;
