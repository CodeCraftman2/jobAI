'use strict';
/**
 * Where JobAI keeps its data: .env, the encrypted key file, the Whisper venv
 * and models, OCR data and Chromium's own folders.
 *
 * The default is the platform app-data folder (%APPDATA%\jobai on Windows).
 * A user can pick another folder in the installer, in onboarding or in
 * Settings. That choice is a one-line pointer file, data-location.txt, in the
 * default folder, so it can be read before the app knows anything else.
 * Order: JOBAI_DATA_DIR (env) > pointer file > default.
 *
 * The pointer is UTF-16LE with a BOM, which the NSIS installer can read and
 * write too (scripts/post-install-nsis.nsh). UTF-8 is also accepted.
 */
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const POINTER_FILE = 'data-location.txt';
const MB = 1024 * 1024;
const GB = 1024 * MB;
// Below this, setup cannot even fit the Whisper venv. Above it but below the
// recommended size, Whisper plus a model may still run out of room.
const MIN_FREE_BYTES = 500 * MB;
const RECOMMENDED_FREE_BYTES = 3 * GB;
const TEST_BYTES = 1 * MB;

// Files that mark a folder as already holding JobAI data.
const MARKERS = ['.env', 'secrets.enc.json', '.jobai-firstrun-completed'];

// Chromium caches and lock files: rebuilt on the next start, often locked
// while the app runs, so they are not copied to a new folder.
const SKIP_ON_COPY = new Set([
  POINTER_FILE,
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'GrShaderCache', 'ShaderCache', 'blob_storage', 'Crashpad', 'Network', 'Shared Dictionary',
  'SharedStorage', 'DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket',
  'lockfile', 'LOCK',
]);

const isWin = process.platform === 'win32';

/** The platform default when not running inside Electron. */
function platformDefaultDir() {
  const home = os.homedir();
  const base = isWin
    ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return path.join(base, 'jobai');
}

function norm(p) {
  let out = path.resolve(String(p));
  // Keep a drive root ("X:\") or "/" as is; drop any other trailing separator.
  if (out.length > path.parse(out).root.length) out = out.replace(/[\\/]+$/, '');
  return isWin ? out.toLowerCase() : out;
}

function samePath(a, b) {
  return norm(a) === norm(b);
}

/** True when `child` is `parent` or inside it. */
function isInside(child, parent) {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function decodePointer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

/** The folder named in the pointer file, or null when there is none (or it is unusable). */
function readPointer(defaultDir) {
  let raw;
  try { raw = fs.readFileSync(path.join(defaultDir, POINTER_FILE)); } catch (_) { return null; }
  const line = decodePointer(raw).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (!line || !path.isAbsolute(line)) return null;
  return path.resolve(line);
}

/** Point the app at `dir`. Pointing at the default removes the pointer. */
function writePointer(defaultDir, dir) {
  const file = path.join(defaultDir, POINTER_FILE);
  if (samePath(dir, defaultDir)) {
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return;
  }
  fs.mkdirSync(defaultDir, { recursive: true });
  const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${path.resolve(dir)}\r\n`, 'utf16le')]);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

/** { dir, source: 'env' | 'pointer' | 'default' } */
function resolveDataDir({ defaultDir = platformDefaultDir(), env = process.env } = {}) {
  if (env.JOBAI_DATA_DIR && String(env.JOBAI_DATA_DIR).trim()) {
    return { dir: path.resolve(String(env.JOBAI_DATA_DIR).trim()), source: 'env' };
  }
  const pointed = readPointer(defaultDir);
  if (pointed) return { dir: pointed, source: 'pointer' };
  return { dir: defaultDir, source: 'default' };
}

function hasJobAIData(dir) {
  return MARKERS.some((m) => fs.existsSync(path.join(dir, m)));
}

/**
 * Checks that need no disk access. Returns a list of problems (empty = fine).
 * `forbidden`: folders the data must not live in, such as the install folder,
 * which updates replace and uninstall removes. `tempDir` (default: the OS temp
 * folder) is refused too; tests pass null.
 */
function validatePath(dir, { forbidden = [], tempDir = os.tmpdir() } = {}) {
  const problems = [];
  const raw = String(dir || '').trim();
  if (!raw) return ['Choose a folder.'];
  if (!path.isAbsolute(raw)) return ['Use a full path, such as X:\\integration\\jobai.'];
  const resolved = path.resolve(raw);
  if (path.parse(resolved).root === resolved || norm(resolved) === norm(path.parse(resolved).root)) {
    problems.push('Pick a folder, not a whole drive. Termax would put its files straight into the drive root.');
  }
  for (const f of forbidden.filter(Boolean)) {
    if (isInside(resolved, f)) {
      problems.push(`This is inside Termax's install folder (${f}), which updates replace and uninstalling removes.`);
      break;
    }
  }
  if (tempDir && isInside(resolved, tempDir)) {
    problems.push('Temp folders get cleaned out by Windows and cleanup tools. Pick a folder of your own.');
  }
  if (/\.asar([\\/]|$)/i.test(resolved)) problems.push('That folder is inside the app package and is read-only.');
  return problems;
}

/** Total size in bytes of what copyData would copy from `dir`. */
async function folderSize(dir, skip = SKIP_ON_COPY) {
  let total = 0;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return 0; }
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await folderSize(p, new Set());
    else if (e.isFile()) {
      try { total += (await fsp.stat(p)).size; } catch (_) { /* gone meanwhile */ }
    }
  }
  return total;
}

async function freeBytes(dir) {
  if (typeof fsp.statfs !== 'function') return null;
  const s = await fsp.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

function fmtBytes(n) {
  if (n == null) return 'unknown';
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= MB) return `${Math.round(n / MB)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/**
 * The folder test behind the "Test folder" buttons. Creates the folder if
 * needed, writes TEST_BYTES of random data, reads it back and compares it, and
 * checks free space (also against the size of the data that would be copied
 * there). Leaves nothing behind: the test file is deleted, and a folder the
 * test created is removed again.
 *
 * Returns { ok, dir, checks: [{ name, ok, detail, level }], freeBytes, needBytes, hasData }.
 * level is 'ok' | 'warn' | 'error'.
 */
async function testDataDir(dir, { forbidden = [], currentDir = null, tempDir } = {}) {
  const checks = [];
  const add = (name, level, detail) => checks.push({ name, ok: level !== 'error', level, detail });
  const result = (extra = {}) => ({
    ok: checks.every((c) => c.level !== 'error'),
    dir: dir ? path.resolve(String(dir).trim()) : '',
    checks,
    ...extra,
  });

  const problems = validatePath(dir, { forbidden, tempDir });
  if (problems.length) {
    problems.forEach((p) => add('Location', 'error', p));
    return result();
  }
  const target = path.resolve(String(dir).trim());

  // Create the folder (and remember to remove it again if it was not there).
  let created = null;
  try {
    const st = await fsp.stat(target);
    if (!st.isDirectory()) {
      add('Folder', 'error', 'A file with that name already exists.');
      return result();
    }
    add('Folder', 'ok', 'Exists');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      add('Folder', 'error', `Cannot open it: ${e.message}`);
      return result();
    }
    try {
      // The topmost folder that does not exist yet (mkdir's own return value
      // comes back as a \? path on Windows, so it is found by hand).
      created = target;
      while (!fs.existsSync(path.dirname(created)) && path.dirname(created) !== created) created = path.dirname(created);
      await fsp.mkdir(target, { recursive: true });
      add('Folder', 'ok', 'Does not exist yet; Termax can create it');
    } catch (e2) {
      add('Folder', 'error', `Cannot create it: ${e2.code === 'EPERM' || e2.code === 'EACCES' ? 'no permission' : e2.message}`);
      return result();
    }
  }

  try {
    // Write, read back, compare.
    const probe = path.join(target, `.jobai-write-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    const data = crypto.randomBytes(TEST_BYTES);
    try {
      const t0 = Date.now();
      await fsp.writeFile(probe, data);
      const back = await fsp.readFile(probe);
      const ms = Math.max(1, Date.now() - t0);
      if (!back.equals(data)) add('Write and read back', 'error', 'The data read back did not match what was written.');
      else add('Write and read back', 'ok', `${fmtBytes(TEST_BYTES)} written and read back intact (${ms} ms)`);
    } catch (e) {
      add('Write and read back', 'error', e.code === 'EPERM' || e.code === 'EACCES' ? 'No permission to write here.' : e.message);
    } finally {
      await fsp.rm(probe, { force: true }).catch(() => {});
    }

    // Free space, also against what would be copied here.
    const hasData = hasJobAIData(target);
    const moving = currentDir && !samePath(currentDir, target) && !hasData;
    const needBytes = moving ? await folderSize(currentDir) : 0;
    let free = null;
    try { free = await freeBytes(target); } catch (_) { free = null; }
    if (free == null) {
      add('Free space', 'warn', 'Could not read the free space on this drive.');
    } else if (free < needBytes + MIN_FREE_BYTES) {
      add('Free space', 'error', `${fmtBytes(free)} free; needs at least ${fmtBytes(needBytes + MIN_FREE_BYTES)}${needBytes ? ` (${fmtBytes(needBytes)} of your data plus room for setup)` : ''}.`);
    } else if (free < needBytes + RECOMMENDED_FREE_BYTES) {
      add('Free space', 'warn', `${fmtBytes(free)} free. Whisper and its models can take a few GB; ${fmtBytes(needBytes + RECOMMENDED_FREE_BYTES)} or more is safer.`);
    } else {
      add('Free space', 'ok', `${fmtBytes(free)} free`);
    }

    if (currentDir && samePath(currentDir, target)) {
      add('Contents', 'ok', 'This is the folder Termax uses now.');
    } else if (hasData) {
      add('Contents', 'ok', 'Already has Termax data (settings, keys). Termax will use it as it is and copy nothing.');
    } else if (moving) {
      add('Contents', 'ok', `Your current data (${fmtBytes(needBytes)}) will be copied here. The old folder is kept.`);
    }
    if (!hasData && !created) {
      const others = (await fsp.readdir(target).catch(() => [])).filter((n) => !n.startsWith('.jobai-write-test-'));
      if (others.length) add('Contents', 'warn', `The folder already has ${others.length} other item(s). Termax's files go next to them; an empty subfolder such as …\\jobai is tidier.`);
    }
    return result({ freeBytes: free, needBytes, hasData });
  } finally {
    if (created) {
      // Remove only folders the test made, and only while still empty.
      let p = target;
      while (isInside(p, created)) {
        try { await fsp.rmdir(p); } catch (_) { break; }
        const up = path.dirname(p);
        if (up === p) break;
        p = up;
      }
    }
  }
}

/** Copies `from` to `to`, file by file, skipping SKIP_ON_COPY at the top level. */
async function copyData(from, to, { onProgress } = {}) {
  const failed = [];
  let files = 0;
  let bytes = 0;
  const walk = async (src, dst, top) => {
    await fsp.mkdir(dst, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const e of entries) {
      if (top && SKIP_ON_COPY.has(e.name)) continue;
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      try {
        if (e.isDirectory()) {
          if (onProgress) onProgress(`Copying ${path.relative(from, s)}`);
          await walk(s, d, false);
        } else if (e.isFile()) {
          // Never overwrite: a file already in the target is the user's.
          await fsp.copyFile(s, d, fs.constants.COPYFILE_EXCL);
          files += 1;
          bytes += (await fsp.stat(d)).size;
        }
      } catch (err) {
        if (err.code !== 'EEXIST') failed.push({ file: path.relative(from, s), error: err.code || err.message });
      }
    }
  };
  await walk(from, to, true);
  return { files, bytes, failed };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * .env values such as WHISPER_COMMAND hold absolute paths into the data
 * folder (the venv's python). Point them at the new folder.
 */
function rewriteEnvPaths(envFile, from, to) {
  let text;
  try { text = fs.readFileSync(envFile, 'utf8'); } catch (_) { return false; }
  const fromAbs = path.resolve(from);
  const toAbs = path.resolve(to);
  const variants = [[fromAbs, toAbs], [fromAbs.replace(/\\/g, '/'), toAbs.replace(/\\/g, '/')]];
  let out = text;
  for (const [a, b] of variants) {
    out = out.replace(new RegExp(escapeRegExp(a), isWin ? 'gi' : 'g'), () => b);
  }
  if (out === text) return false;
  fs.writeFileSync(envFile, out);
  return true;
}

/**
 * Switch the app to `to`: test it, copy the current data there (unless it
 * already has Termax data), fix paths in its .env and write the pointer. The
 * old folder is left untouched. The app has to restart to use the new folder.
 */
async function switchDataDir({ from, to, defaultDir, forbidden = [], tempDir, onProgress } = {}) {
  const target = path.resolve(String(to || '').trim());
  if (from && samePath(from, target)) return { changed: false, dir: target };

  const test = await testDataDir(target, { forbidden, currentDir: from, tempDir });
  if (!test.ok) {
    const err = new Error(test.checks.filter((c) => c.level === 'error').map((c) => c.detail).join(' '));
    err.test = test;
    throw err;
  }

  let copy = { files: 0, bytes: 0, failed: [] };
  const usedExisting = test.hasData;
  if (!usedExisting && from && fs.existsSync(from)) {
    copy = await copyData(from, target, { onProgress });
    rewriteEnvPaths(path.join(target, '.env'), from, target);
  } else {
    await fsp.mkdir(target, { recursive: true });
  }
  writePointer(defaultDir, target);
  return { changed: true, dir: target, usedExisting, ...copy };
}

module.exports = {
  POINTER_FILE,
  MIN_FREE_BYTES,
  RECOMMENDED_FREE_BYTES,
  platformDefaultDir,
  readPointer,
  writePointer,
  resolveDataDir,
  hasJobAIData,
  validatePath,
  testDataDir,
  copyData,
  rewriteEnvPaths,
  switchDataDir,
  samePath,
  isInside,
  fmtBytes,
};
