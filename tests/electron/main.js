// Tests that need Electron itself (nativeImage, safeStorage, the OCR worker
// inside Electron). Run with `npm run test:electron`.
const { app, safeStorage, nativeImage } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const results = [];

// Closing the helper window must not end the run before the report is written.
app.on('window-all-closed', () => {});

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
}

/** A busy, screenshot-sized picture (gradient plus noise) so it does not compress away. */
function bigPng(width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const noise = (x * 31 + y * 17) % 53;
      data[i] = (x / width) * 255 + noise; data[i + 1] = (y / height) * 255; data[i + 2] = noise * 4; data[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(data, { width, height }).toPNG();
}

app.whenReady().then(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobai-electron-'));
  process.env.JOBAI_DATA_DIR = dataDir;

  await check('a 4K screenshot is shrunk to 1600 px and a fraction of the size', () => {
    const { shrinkImage } = require(path.join(root, 'src', 'core', 'image-utils'));
    const png = bigPng(3840, 2160);
    const out = shrinkImage(png, 'image/png');
    assert.strictEqual(out.shrunk, true);
    assert.strictEqual(out.mimeType, 'image/jpeg');
    assert.ok(Math.max(out.width, out.height) <= 1600, `${out.width}x${out.height}`);
    assert.ok(out.buffer.length < png.length / 3, `${png.length} -> ${out.buffer.length}`);
    assert.ok(nativeImage.createFromBuffer(out.buffer).getSize().width === out.width, 'still a valid image');
  });

  await check('a small image is not enlarged or made bigger', () => {
    const { shrinkImage } = require(path.join(root, 'src', 'core', 'image-utils'));
    const png = bigPng(64, 64);
    const out = shrinkImage(png, 'image/png');
    assert.ok(out.buffer.length <= png.length);
    assert.ok(nativeImage.createFromBuffer(out.buffer).getSize().width <= 64);
  });

  await check('garbage bytes come back unchanged instead of crashing', () => {
    const { shrinkImage } = require(path.join(root, 'src', 'core', 'image-utils'));
    const junk = Buffer.from('not an image at all');
    assert.strictEqual(shrinkImage(junk, 'image/png').buffer, junk);
  });

  await check('keys are encrypted on disk and come back after a restart', () => {
    const store = require(path.join(root, 'src', 'core', 'secure-store'));
    assert.ok(store.init(dataDir, safeStorage), 'no OS keychain here');
    assert.strictEqual(store.set('GEMINI_API_KEY', 'AIza-test-secret-123'), true);
    assert.strictEqual(store.set('NOT_A_SECRET_NAME', 'x'), false);
    const onDisk = fs.readFileSync(path.join(dataDir, 'secrets.enc.json'), 'utf8');
    assert.ok(!onDisk.includes('AIza-test-secret'), 'plaintext on disk');
    store.safeStorage = safeStorage; // same process, new read
    assert.strictEqual(store.get('GEMINI_API_KEY'), 'AIza-test-secret-123');
    delete process.env.GEMINI_API_KEY;
    assert.deepStrictEqual(store.loadIntoEnv(), ['GEMINI_API_KEY']);
    assert.strictEqual(process.env.GEMINI_API_KEY, 'AIza-test-secret-123');
    store.set('GEMINI_API_KEY', '');
    assert.strictEqual(store.get('GEMINI_API_KEY'), '');
  });

  await check('OCR reads text inside Electron', async () => {
    const ocr = require(path.join(root, 'src', 'services', 'ocr.service'));
    process.env.OCR_DATA_DIR = path.join(dataDir, 'ocr');
    const installed = await ocr.install();
    assert.ok(installed.ok, installed.message);
    // Render some text to a picture with a hidden window and capture it.
    const { BrowserWindow } = require('electron');
    const win = new BrowserWindow({ show: false, width: 700, height: 200, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:20px;font:36px Arial;background:#fff">Hello JobAI OCR test</body>'));
    await new Promise((r) => setTimeout(r, 400));
    const image = await win.webContents.capturePage();
    win.destroy();
    const text = await ocr.recognize(image.toPNG());
    await ocr.shutdown();
    assert.ok(/hello/i.test(text) && /ocr/i.test(text), `read: ${JSON.stringify(text)}`);
  });

  let failed = 0;
  const lines = [];
  for (const r of results) {
    if (!r.ok) failed++;
    lines.push((r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + (r.ok ? '' : '\n      ' + r.error));
  }
  lines.push('\n' + (results.length - failed) + '/' + results.length + ' passed');
  // Electron's own stdout is unreliable on Windows, so the report goes through a file.
  const report = lines.join('\n');
  if (process.env.JOBAI_TEST_OUT) fs.writeFileSync(process.env.JOBAI_TEST_OUT, report, 'utf8');
  else console.log(report);
  app.exit(failed ? 1 : 0);
});
