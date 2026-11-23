const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dl = require('../src/core/data-location');

// Everything here lives under the OS temp folder, which the app refuses as a
// data folder; tempDir: null turns that one check off for the tests.
const T = { tempDir: null };

function tmp(name = 'dl') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jobai-${name}-`));
}

function seedData(dir) {
  fs.mkdirSync(path.join(dir, '.venv-whisper', 'Scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.venv-whisper', 'Scripts', 'python.exe'), 'py');
  fs.mkdirSync(path.join(dir, 'ocr'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ocr', 'eng.traineddata'), 'x'.repeat(2048));
  fs.writeFileSync(path.join(dir, 'secrets.enc.json'), '{"k":"enc"}');
  fs.writeFileSync(path.join(dir, '.jobai-firstrun-completed'), 'done');
  const py = path.join(dir, '.venv-whisper', 'Scripts', 'python.exe');
  fs.writeFileSync(path.join(dir, '.env'), `GEMINI_API_KEY=\nWHISPER_COMMAND='"${py}" -m whisper'\nAPP_NAME=Termax\n`);
  // Chromium cache and the pointer: never copied.
  fs.mkdirSync(path.join(dir, 'GPUCache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'GPUCache', 'data_0'), 'cache');
  return py;
}

// ── Where the data folder is ──────────────────────────────────────────
test('data folder: env beats pointer beats default', () => {
  const def = tmp('def');
  const chosen = tmp('chosen');
  assert.deepEqual(dl.resolveDataDir({ defaultDir: def, env: {} }), { dir: def, source: 'default' });
  dl.writePointer(def, chosen);
  assert.deepEqual(dl.resolveDataDir({ defaultDir: def, env: {} }), { dir: path.resolve(chosen), source: 'pointer' });
  const fromEnv = path.join(chosen, 'env');
  assert.deepEqual(dl.resolveDataDir({ defaultDir: def, env: { JOBAI_DATA_DIR: fromEnv } }), { dir: fromEnv, source: 'env' });
});

test('pointer: written as UTF-16LE with a BOM (what the installer reads), non-ASCII paths survive', () => {
  const def = tmp('def');
  const chosen = path.join(tmp('chosen'), 'données ✓');
  dl.writePointer(def, chosen);
  const raw = fs.readFileSync(path.join(def, dl.POINTER_FILE));
  assert.equal(raw[0], 0xff);
  assert.equal(raw[1], 0xfe);
  assert.equal(dl.readPointer(def), path.resolve(chosen));
});

test('pointer: plain UTF-8 (hand-edited) is read too; a relative path is ignored', () => {
  const def = tmp('def');
  const chosen = tmp('chosen');
  fs.writeFileSync(path.join(def, dl.POINTER_FILE), `\n  ${chosen}  \r\n`);
  assert.equal(dl.readPointer(def), path.resolve(chosen));
  fs.writeFileSync(path.join(def, dl.POINTER_FILE), 'relative\\folder');
  assert.equal(dl.readPointer(def), null);
});

test('pointer: choosing the default folder again removes the pointer', () => {
  const def = tmp('def');
  dl.writePointer(def, tmp('chosen'));
  dl.writePointer(def, def);
  assert.equal(fs.existsSync(path.join(def, dl.POINTER_FILE)), false);
  assert.equal(dl.resolveDataDir({ defaultDir: def, env: {} }).source, 'default');
});

// ── Path checks ───────────────────────────────────────────────────────
test('validatePath: refuses empty, relative, a drive root, the install folder and temp', () => {
  assert.equal(dl.validatePath('').length, 1);
  assert.match(dl.validatePath('some\\folder')[0], /full path/);
  assert.match(dl.validatePath(path.parse(os.tmpdir()).root, T).join(' '), /not a whole drive/);
  const install = tmp('install');
  assert.match(dl.validatePath(path.join(install, 'data'), { forbidden: [install], ...T }).join(' '), /install folder/);
  assert.match(dl.validatePath(path.join(os.tmpdir(), 'x')).join(' '), /Temp/);
  assert.deepEqual(dl.validatePath(path.join(install + '2', 'data'), { forbidden: [install], ...T }), []);
});

// ── The folder test ("Test folder" button) ─────────────────────────────
test('folder test: writes 1 MB, reads it back intact, checks free space, leaves nothing behind', async () => {
  const parent = tmp('parent');
  const target = path.join(parent, 'new', 'jobai');
  const r = await dl.testDataDir(target, T);
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  const rw = r.checks.find((c) => c.name === 'Write and read back');
  assert.equal(rw.level, 'ok');
  assert.match(rw.detail, /1 MB written and read back intact/);
  const space = r.checks.find((c) => c.name === 'Free space');
  assert.ok(space && space.level !== 'error', JSON.stringify(space));
  assert.ok(r.freeBytes > 0);
  // The folders the test created are gone again, and so is the probe file.
  assert.equal(fs.existsSync(path.join(parent, 'new')), false);
  assert.deepEqual(fs.readdirSync(parent), []);
});

test('folder test: an existing folder is kept, and only the probe file is removed', async () => {
  const dir = tmp('keep');
  fs.writeFileSync(path.join(dir, 'mine.txt'), 'keep me');
  const r = await dl.testDataDir(dir, T);
  assert.equal(r.ok, true);
  assert.deepEqual(fs.readdirSync(dir), ['mine.txt']);
  assert.ok(r.checks.some((c) => c.level === 'warn' && /other item/.test(c.detail)));
});

test('folder test: a file in the way fails; a folder with Termax data says it will be used as is', async () => {
  const dir = tmp('file');
  const file = path.join(dir, 'x');
  fs.writeFileSync(file, '');
  const bad = await dl.testDataDir(file, T);
  assert.equal(bad.ok, false);
  assert.match(bad.checks[0].detail, /file with that name/);

  const withData = tmp('data');
  seedData(withData);
  const good = await dl.testDataDir(withData, { ...T, currentDir: tmp('cur') });
  assert.equal(good.ok, true);
  assert.equal(good.hasData, true);
  assert.ok(good.checks.some((c) => /use it as it is/.test(c.detail)));
});

test('folder test: counts the data to be copied against free space', async () => {
  const cur = tmp('cur');
  seedData(cur);
  const r = await dl.testDataDir(path.join(tmp('to'), 'jobai'), { ...T, currentDir: cur });
  assert.equal(r.ok, true);
  assert.ok(r.needBytes >= 2048, `needBytes ${r.needBytes}`);
  assert.ok(r.checks.some((c) => /will be copied here/.test(c.detail)));
});

// ── Moving the data ───────────────────────────────────────────────────
test('switch: copies data (not caches), fixes .env paths, writes the pointer, keeps the old folder', async () => {
  const def = tmp('def');
  const oldPy = seedData(def);
  const to = path.join(tmp('to'), 'jobai');
  const r = await dl.switchDataDir({ from: def, to, defaultDir: def, ...T });
  assert.equal(r.changed, true);
  assert.equal(r.usedExisting, false);
  assert.deepEqual(r.failed, []);
  assert.ok(fs.existsSync(path.join(to, '.venv-whisper', 'Scripts', 'python.exe')));
  assert.ok(fs.existsSync(path.join(to, 'ocr', 'eng.traineddata')));
  assert.ok(fs.existsSync(path.join(to, 'secrets.enc.json')));
  assert.equal(fs.existsSync(path.join(to, 'GPUCache')), false);
  assert.equal(fs.existsSync(path.join(to, dl.POINTER_FILE)), false);
  const env = fs.readFileSync(path.join(to, '.env'), 'utf8');
  assert.ok(env.includes(path.join(path.resolve(to), '.venv-whisper', 'Scripts', 'python.exe')), env);
  assert.ok(!env.toLowerCase().includes(path.resolve(def).toLowerCase()), env);
  // Old folder untouched; the app now resolves to the new one.
  assert.ok(fs.readFileSync(path.join(def, '.env'), 'utf8').includes(oldPy));
  assert.deepEqual(dl.resolveDataDir({ defaultDir: def, env: {} }), { dir: path.resolve(to), source: 'pointer' });
});

test('switch: a folder that already has Termax data is used as is, nothing copied over it', async () => {
  const def = tmp('def');
  seedData(def);
  const to = tmp('existing');
  fs.writeFileSync(path.join(to, '.env'), 'APP_NAME=Mine\n');
  const r = await dl.switchDataDir({ from: def, to, defaultDir: def, ...T });
  assert.equal(r.usedExisting, true);
  assert.equal(r.files, 0);
  assert.equal(fs.readFileSync(path.join(to, '.env'), 'utf8'), 'APP_NAME=Mine\n');
  assert.equal(fs.existsSync(path.join(to, 'secrets.enc.json')), false);
});

test('switch: a bad folder is refused and no pointer is written', async () => {
  const def = tmp('def');
  seedData(def);
  await assert.rejects(
    dl.switchDataDir({ from: def, to: path.join(def, 'inside'), defaultDir: def, forbidden: [def], ...T }),
    /install folder/,
  );
  assert.equal(fs.existsSync(path.join(def, dl.POINTER_FILE)), false);
});

test('switch: the same folder is a no-op', async () => {
  const def = tmp('def');
  const r = await dl.switchDataDir({ from: def, to: def + path.sep, defaultDir: def, ...T });
  assert.equal(r.changed, false);
});

test('copy: never overwrites a file already in the target', async () => {
  const from = tmp('from');
  const to = tmp('to');
  fs.writeFileSync(path.join(from, 'a.txt'), 'new');
  fs.writeFileSync(path.join(to, 'a.txt'), 'old');
  const r = await dl.copyData(from, to);
  assert.equal(fs.readFileSync(path.join(to, 'a.txt'), 'utf8'), 'old');
  assert.deepEqual(r.failed, []);
});

// ── Plain node (setup scripts) follows the same choice ────────────────
test('appDataDir outside Electron follows the pointer', { skip: process.platform === 'darwin' }, () => {
  const base = tmp('appdata');
  const saved = { APPDATA: process.env.APPDATA, XDG: process.env.XDG_CONFIG_HOME, D: process.env.JOBAI_DATA_DIR };
  process.env.APPDATA = base;
  process.env.XDG_CONFIG_HOME = base;
  delete process.env.JOBAI_DATA_DIR;
  try {
    const chosen = tmp('chosen');
    dl.writePointer(path.join(base, 'jobai'), chosen);
    delete require.cache[require.resolve('../src/core/paths')];
    const { appDataDir } = require('../src/core/paths');
    assert.equal(appDataDir(), path.resolve(chosen));
  } finally {
    const restore = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore('APPDATA', saved.APPDATA);
    restore('XDG_CONFIG_HOME', saved.XDG);
    restore('JOBAI_DATA_DIR', saved.D);
  }
});
