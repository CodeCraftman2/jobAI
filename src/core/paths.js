const { resolveDataDir, platformDefaultDir } = require('./data-location');

/**
 * The app's data folder. Inside Electron this is userData (the same folder
 * that holds .env and the keychain file), which main.js points at the folder
 * the user chose. In plain node (setup scripts, tests) the same choice is
 * read: JOBAI_DATA_DIR, else the data-location.txt pointer, else the default.
 */
function appDataDir() {
  if (process.env.JOBAI_DATA_DIR) return process.env.JOBAI_DATA_DIR;
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      return electron.app.getPath('userData');
    }
  } catch (_) { /* plain node */ }
  return resolveDataDir({ defaultDir: platformDefaultDir() }).dir;
}

module.exports = { appDataDir };
