const os = require('os');
const path = require('path');

/**
 * The app's data folder. Inside Electron this is userData (the same folder
 * that holds .env and the keychain file); in plain node (setup scripts,
 * tests) it is the same default location. JOBAI_DATA_DIR overrides it.
 */
function appDataDir() {
  if (process.env.JOBAI_DATA_DIR) return process.env.JOBAI_DATA_DIR;
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      return electron.app.getPath('userData');
    }
  } catch (_) { /* plain node */ }
  const home = os.homedir();
  const base = process.platform === 'win32'
    ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return path.join(base, 'jobai');
}

module.exports = { appDataDir };
