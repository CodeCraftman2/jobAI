const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets, limitText, sanitizeRequest, MAX_IMAGES } = require('../src/core/privacy');
const { scrub } = require('../src/core/logger');

test('redacts the key formats providers use', () => {
  const secrets = [
    'sk-or-v1-0123456789abcdef0123456789abcdef',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    'AIzaSyA-1234567890abcdefghijklmnopqrstuv',
    'AQ.Ab8RN6JqbvjrcWfyHowmeNXu30FspIOzfbJB9wYynMbUk1',
    'nvapi-abcdefghijklmnopqrstuvwxyz0123',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'AKIAABCDEFGHIJKLMNOP',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz',
    'xoxb-1234567890-abcdefghij'
  ];
  for (const secret of secrets) {
    const out = redactSecrets(`here is my key ${secret} please help`);
    assert.ok(!out.includes(secret), `leaked: ${secret}`);
    assert.match(out, /\[redacted\]/);
  }
});

test('redacts bearer tokens, private keys and key=value secrets', () => {
  assert.ok(!redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345').includes('abcdefghijklmnop'));
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----';
  assert.ok(!redactSecrets(`x ${pem} y`).includes('MIIEabc'));
  assert.ok(!redactSecrets('API_KEY = "a1b2c3d4e5f6g7h8i9j0"').includes('a1b2c3d4e5'));
  assert.ok(!redactSecrets('password: hunter2hunter2hunter2').includes('hunter2hunter2'));
});

test('leaves ordinary code and prose alone', () => {
  const code = [
    'token = tokens[i]',
    'const password = input.value;',
    'secret_santa = pick_random(names)',
    'for (let i = 0; i < n; i++) { sum += arr[i]; }',
    'Explain how a hash map handles collisions.'
  ].join('\n');
  assert.equal(redactSecrets(code), code);
});

test('limitText keeps the head and the tail', () => {
  const text = 'A'.repeat(500) + 'MIDDLE' + 'Z'.repeat(500);
  const out = limitText(text, 200);
  assert.ok(out.length < 300);
  assert.ok(out.startsWith('AAAA') && out.endsWith('ZZZZ'));
  assert.match(out, /characters omitted/);
  assert.equal(limitText('short', 200), 'short');
});

test('history is capped to the newest messages and opens with the user', () => {
  process.env.JOBAI_MAX_CONTEXT_CHARS = '5000';
  try {
    const contents = [];
    for (let i = 0; i < 100; i++) {
      contents.push({ role: i % 2 ? 'model' : 'user', parts: [{ text: `message ${i} ` + 'x'.repeat(900) }] });
    }
    contents.push({ role: 'user', parts: [{ text: 'THE CURRENT QUESTION' }] });
    const request = { contents };
    const stats = sanitizeRequest(request);
    const total = request.contents.reduce((n, c) => n + c.parts[0].text.length, 0);
    assert.ok(total <= 5000 + 100, `sent ${total} chars`);
    assert.ok(stats.droppedMessages > 80);
    assert.equal(request.contents.at(-1).parts[0].text, 'THE CURRENT QUESTION');
    assert.equal(request.contents[0].role, 'user');
  } finally {
    delete process.env.JOBAI_MAX_CONTEXT_CHARS;
  }
});

test('a single huge message is truncated, never dropped', () => {
  const request = { contents: [{ role: 'user', parts: [{ text: 'q '.repeat(50000) }] }] };
  sanitizeRequest(request);
  assert.equal(request.contents.length, 1);
  assert.ok(request.contents[0].parts[0].text.length < 13000);
});

test('only the newest images are kept', () => {
  const img = (n) => ({ inlineData: { data: String(n), mimeType: 'image/png' } });
  const request = { contents: [
    { role: 'user', parts: [{ text: 'a' }, img(1)] },
    { role: 'model', parts: [{ text: 'b' }] },
    { role: 'user', parts: [{ text: 'c' }, img(2), img(3)] }
  ] };
  const stats = sanitizeRequest(request);
  const kept = request.contents.flatMap((c) => c.parts.filter((p) => p.inlineData).map((p) => p.inlineData.data));
  assert.equal(kept.length, MAX_IMAGES);
  assert.deepEqual(kept, ['2', '3']);
  assert.equal(stats.droppedImages, 1);
});

test('sanitizing twice changes nothing more', () => {
  const request = { contents: [{ role: 'user', parts: [{ text: 'key sk-or-v1-0123456789abcdef0123456789abcdef and ' + 'y'.repeat(20000) }] }] };
  sanitizeRequest(request);
  const once = JSON.stringify(request);
  sanitizeRequest(request);
  assert.equal(JSON.stringify(request), once);
});

test('logs never hold secrets or what was said', () => {
  const cleaned = scrub({
    text: 'my interview question',
    responsePreview: 'the model answer',
    transcript: 'spoken words',
    error: 'failed with key sk-or-v1-0123456789abcdef0123456789abcdef',
    model: 'some/model',
    nested: { response: 'secret answer', count: 3 }
  });
  assert.equal(cleaned.text, '[omitted 21 chars]');
  assert.match(cleaned.responsePreview, /omitted/);
  assert.match(cleaned.transcript, /omitted/);
  assert.ok(!cleaned.error.includes('0123456789abcdef'));
  assert.equal(cleaned.model, 'some/model');
  assert.match(cleaned.nested.response, /omitted/);
  assert.equal(cleaned.nested.count, 3);
});
