const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { parseCurl } = require('../src/ui/curl-parser');
const visionProbe = require('../src/core/vision-probe');
const FirstRunManager = require('../src/core/first-run');

// ── curl parser: any provider, not one in particular ────────────────────
test('curl: OpenRouter', () => {
  const r = parseCurl(`curl https://openrouter.ai/api/v1/chat/completions \\
    -H "Authorization: Bearer sk-or-v1-abc" -H "Content-Type: application/json" \\
    -d '{"model":"openai/gpt-5","messages":[]}'`);
  assert.equal(r.ok, true);
  assert.equal(r.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(r.format, 'openai');
  assert.equal(r.auth, 'bearer');
  assert.equal(r.apiKey, 'sk-or-v1-abc');
  assert.equal(r.model, 'openai/gpt-5');
});

test('curl: any other host and an x-api-key header', () => {
  const r = parseCurl(`curl https://api.example-gateway.dev/v2/messages -H 'x-api-key: abc123' -d '{"model":"m1"}'`);
  assert.equal(r.baseUrl, 'https://api.example-gateway.dev/v2');
  assert.equal(r.format, 'anthropic');
  assert.equal(r.auth, 'x-api-key');
});

test('curl: a key left as a variable is not taken as the key', () => {
  const r = parseCurl('curl https://x.example/v1/chat/completions -H "Authorization: Bearer $API_KEY"');
  assert.equal(r.ok, true);
  assert.equal(r.apiKey, '');
  assert.match(r.warning, /variable/);
});

test('curl: nothing useful', () => {
  assert.equal(parseCurl('').ok, false);
  assert.equal(parseCurl('curl -H "a: b"').ok, false);
});

// ── vision probe image ──────────────────────────────────────────────────
test('the probe image is a valid solid-red PNG', () => {
  const png = Buffer.from(visionProbe.PROBE_IMAGE_BASE64, 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 64); // width
  assert.equal(png.readUInt32BE(20), 64); // height
  const idatLen = png.readUInt32BE(33);
  const raw = zlib.inflateSync(png.subarray(41, 41 + idatLen));
  assert.equal(raw.length, 64 * (1 + 64 * 3));
  assert.deepEqual([raw[1], raw[2], raw[3]], [230, 20, 20]);
});

test('only a reply naming the colour passes', () => {
  assert.equal(visionProbe.passed('Red'), true);
  assert.equal(visionProbe.passed('The image is red.'), true);
  assert.equal(visionProbe.passed("I can't see any image"), false);
  assert.equal(visionProbe.passed('answer from some/model'), false);
  assert.equal(visionProbe.passed(''), false);
});

// ── remembered model knowledge ──────────────────────────────────────────
test('model health is remembered across restarts and expires', () => {
  process.env.JOBAI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jobai-health-'));
  const health = require('../src/core/model-health');
  health.reset();
  assert.equal(health.getVision('u|m'), undefined);
  health.setVision('u|m', true);
  health.setVision('u|n', false);
  health.recordLatency('u|m', 1000);
  health.recordLatency('u|m', 500);
  assert.equal(health.latency('u|m'), 850);
  health.setDiscovered('u', ['a', 'b']);
  health.flush();

  health.reset(); // as if the app restarted
  assert.equal(health.getVision('u|m'), true);
  assert.equal(health.getVision('u|n'), false);
  assert.deepEqual(health.getDiscovered('u'), ['a', 'b']);

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 2 * 24 * 3600 * 1000; // two days later
    assert.equal(health.getVision('u|n'), undefined, 'a "no" is re-tested after a day');
    assert.equal(health.getVision('u|m'), true, 'a "yes" lasts a week');
    Date.now = () => realNow() + 8 * 24 * 3600 * 1000;
    assert.equal(health.getVision('u|m'), undefined);
    assert.equal(health.getDiscovered('u'), null, 'discovered models are rescanned after hours');
  } finally {
    Date.now = realNow;
  }
});

// ── setup: Gemini is the one required key, wherever it is stored ────────
test('setup is needed until a Gemini key exists, in .env or the keychain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobai-first-'));
  const envPath = path.join(dir, '.env');
  const sentinelPath = path.join(dir, 'done');
  fs.writeFileSync(sentinelPath, 'x');
  fakeWhisper(dir, 'small'); // speech is ready, so only the AI key decides

  fs.writeFileSync(envPath, 'GEMINI_API_KEY=\nGATEWAY_API_KEY=sk-or-realkey123456\n');
  assert.equal(new FirstRunManager({ envPath, sentinelPath, logger: {} }).needsOnboarding(), true, 'an other-AI key alone is not enough');

  fs.writeFileSync(envPath, 'GEMINI_API_KEY=\nLLM_PROVIDER=gateway\nGATEWAY_BASE_URL=http://localhost:11434/v1\nGATEWAY_API_KEY=ollama\n');
  assert.equal(new FirstRunManager({ envPath, sentinelPath, logger: {} }).needsOnboarding(), false, 'a chosen custom provider (e.g. local Ollama) is enough');
  fs.writeFileSync(envPath, 'GEMINI_API_KEY=\nLLM_PROVIDER=gateway\nGATEWAY_API_KEY=ollama\n');
  assert.equal(new FirstRunManager({ envPath, sentinelPath, logger: {} }).needsOnboarding(), true, 'but it needs a base URL');

  fs.writeFileSync(envPath, 'GEMINI_API_KEY=AIzaSyRealKey\n');
  assert.equal(new FirstRunManager({ envPath, sentinelPath, logger: {} }).needsOnboarding(), false);

  fs.writeFileSync(envPath, 'GEMINI_API_KEY=your_gemini_api_key_here\n');
  assert.equal(new FirstRunManager({ envPath, sentinelPath, logger: {} }).needsOnboarding(), true, 'the placeholder is not a key');

  fs.writeFileSync(envPath, 'GEMINI_API_KEY=\n');
  const secrets = { get: (k) => (k === 'GEMINI_API_KEY' ? 'AIzaSyFromKeychain' : '') };
  const status = new FirstRunManager({ envPath, sentinelPath, logger: {}, secrets });
  assert.equal(status.needsOnboarding(), false, 'a key in the keychain counts');
  assert.equal(status.getStatus().geminiConfigured, true);
});

// ── setup also checks that local Whisper and its model are really here ──
test('setup is offered again when Whisper or its model is gone (e.g. after an uninstall)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobai-first-'));
  const envPath = path.join(dir, '.env');
  const sentinelPath = path.join(dir, 'done');
  fs.writeFileSync(sentinelPath, 'x');
  const check = () => new FirstRunManager({ envPath, sentinelPath, logger: {}, dataDir: dir, platform: 'win32' });
  const missing = path.join(dir, 'nope', 'whisper.exe');

  // Left over from an earlier install: done marker + key, but no venv and no model.
  fs.writeFileSync(envPath, `GEMINI_API_KEY=AIzaSyRealKey\nSPEECH_PROVIDER=whisper\nWHISPER_COMMAND="${missing}"\nWHISPER_MODEL=small.en\n`);
  assert.equal(check().needsOnboarding(), true, 'no Whisper install');
  assert.equal(check().getStatus().speechReady, false);

  fakeWhisper(dir, null, 'win32');
  assert.equal(check().needsOnboarding(), true, 'Whisper but no model');

  fs.writeFileSync(path.join(dir, '.whisper-models', 'small.en.pt'), 'x');
  assert.equal(check().needsOnboarding(), false, 'Whisper and the chosen model');

  fs.rmSync(path.join(dir, '.whisper-models', 'small.en.pt'));
  fs.appendFileSync(envPath, 'WHISPER_MODEL_DOWNLOAD=later\n');
  assert.equal(check().needsOnboarding(), false, 'model chosen to download on first use');

  fs.rmSync(path.join(dir, '.venv-whisper'), { recursive: true });
  fs.writeFileSync(envPath, 'GEMINI_API_KEY=AIzaSyRealKey\nSPEECH_PROVIDER=azure\nAZURE_SPEECH_KEY=k\nAZURE_SPEECH_REGION=eastus\n');
  assert.equal(check().needsOnboarding(), false, 'Azure needs no local Whisper');
  fs.writeFileSync(envPath, 'GEMINI_API_KEY=AIzaSyRealKey\nSPEECH_PROVIDER=azure\nAZURE_SPEECH_KEY=k\n');
  assert.equal(check().needsOnboarding(), true, 'Azure without a region');
});

/** A Whisper venv (and optionally a model) where the onboarding wizard puts them. */
function fakeWhisper(dir, model, platform = process.platform) {
  const win = platform === 'win32';
  const bin = path.join(dir, '.venv-whisper', win ? 'Scripts' : 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, win ? 'whisper.exe' : 'whisper'), '');
  fs.mkdirSync(path.join(dir, '.whisper-models'), { recursive: true });
  if (model) fs.writeFileSync(path.join(dir, '.whisper-models', `${model}.pt`), 'x');
}

// ── speech polyfills must not replace Node's own URL / Blob ─────────────
test('loading the speech service keeps the real URL, so http:// AI servers still work', () => {
  const RealURL = URL;
  require('../src/services/speech.service');
  assert.equal(globalThis.URL, RealURL);
  assert.equal(new URL('http://localhost:11434/v1').protocol, 'http:');
  assert.equal(typeof new Blob(['x']).size, 'number');
});
