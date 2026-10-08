const test = require('node:test');
const assert = require('node:assert/strict');
const { startMockGateway } = require('./helpers/mock-gateway');
const { llm, modelHealth, configure, collectNotices, textRequest, stubOcr, USER_SHOT_B64 } = require('./helpers/service');

const run = (request) => llm.executeRequest(request);

// ── routing and speed ───────────────────────────────────────────────────
test('a plain question goes to the first listed model', async (t) => {
  const gw = await startMockGateway({ models: ['a/one', 'b/two'] });
  t.after(() => gw.close());
  configure(gw, { GATEWAY_MODELS: 'a/one,b/two' });
  assert.equal(await run(textRequest('what is a heap?')), 'answer from a/one');
  assert.equal(gw.chatCalls().length, 1);
});

test('a failing model is left behind quickly, with no long retry waits', async (t) => {
  const gw = await startMockGateway({ models: ['bad/one', 'good/two'], status: { 'bad/one': 429 } });
  t.after(() => gw.close());
  configure(gw, { GATEWAY_MODELS: 'bad/one,good/two' });
  const started = Date.now();
  assert.equal(await run(textRequest('hello')), 'answer from good/two');
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  assert.equal(gw.chatCalls().filter((c) => c.model === 'bad/one').length, 1, 'no repeat of a rate-limited model');
});

test('a model that just failed is skipped on the next question', async (t) => {
  const gw = await startMockGateway({ models: ['bad/one', 'good/two'], status: { 'bad/one': 500 } });
  t.after(() => gw.close());
  configure(gw, { GATEWAY_MODELS: 'bad/one,good/two' });
  await run(textRequest('first'));
  gw.reset();
  await run(textRequest('second'));
  assert.deepEqual(gw.chatCalls().map((c) => c.model), ['good/two']);
});

test('streaming works and reports each piece', async (t) => {
  const gw = await startMockGateway({ models: ['a/one'] });
  t.after(() => gw.close());
  configure(gw, { GATEWAY_MODELS: 'a/one' });
  const pieces = [];
  const text = await llm.executeStreamingRequest(textRequest('hi'), (d) => pieces.push(d));
  assert.equal(text, 'answer from a/one');
  assert.ok(pieces.length >= 1);
});

// ── images: never to a model that has not proved it can read them ──────
test('metadata says who reads images: only they get the screenshot', async (t) => {
  const gw = await startMockGateway({ models: ['txt/a', 'txt/b', 'vis/c'], vision: ['vis/c'] });
  t.after(() => gw.close());
  configure(gw, { GATEWAY_MODELS: 'txt/a,txt/b' });
  const answer = await run(textRequest('what is on screen?', { image: true }));
  assert.equal(answer, 'answer from vis/c');
  const sentShot = gw.calls.filter((c) => c.raw.includes(USER_SHOT_B64));
  assert.deepEqual(sentShot.map((c) => c.model), ['vis/c'], 'the screenshot reached only the vision model');
});

test('a provider with no metadata: images are found by testing, and remembered', async (t) => {
  const gw = await startMockGateway({ models: ['txt/a', 'vis/c', 'txt/b'], vision: ['vis/c'], metadata: false });
  t.after(() => gw.close());
  configure(gw, { GATEWAY_MODELS: 'txt/a,vis/c,txt/b' });

  assert.equal(await run(textRequest('screen?', { image: true })), 'answer from vis/c');
  const leaked = gw.calls.filter((c) => c.raw.includes(USER_SHOT_B64) && c.model !== 'vis/c');
  assert.equal(leaked.length, 0, 'the real screenshot never reached an untested model');
  assert.ok(gw.probeCalls().length >= 1, 'a probe was used');
  assert.equal(modelHealth.getVision(`${gw.url}|vis/c`), true);
  assert.equal(modelHealth.getVision(`${gw.url}|txt/a`), false);

  gw.reset();
  assert.equal(await run(textRequest('again?', { image: true })), 'answer from vis/c');
  assert.equal(gw.probeCalls().length, 0, 'the answer was remembered, no new probe');
});

test('no model reads images: OCR text is sent instead and no image leaves', async (t) => {
  const gw = await startMockGateway({ models: ['txt/a', 'txt/b'] });
  t.after(() => gw.close());
  const restore = stubOcr('Two Sum: given nums and target, return indices.');
  t.after(restore);
  configure(gw, { GATEWAY_MODELS: 'txt/a,txt/b' });
  const notices = collectNotices();
  const request = textRequest('solve this', { image: true });
  assert.equal(await run(request), 'answer from txt/a');
  assert.ok(gw.calls.every((c) => !c.raw.includes(USER_SHOT_B64)), 'no screenshot was sent');
  assert.ok(gw.chatCalls().some((c) => c.raw.includes('Two Sum')), 'the OCR text was sent');
  assert.ok(notices.some((n) => /OCR/.test(n.message)));
});

test('secrets read from the screen by OCR are redacted before sending', async (t) => {
  const gw = await startMockGateway({ models: ['txt/a'] });
  t.after(() => gw.close());
  const restore = stubOcr('const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";');
  t.after(restore);
  configure(gw, { GATEWAY_MODELS: 'txt/a' });
  await run(textRequest('what does this do', { image: true }));
  assert.ok(gw.calls.every((c) => !c.raw.includes('0123456789abcdef')), 'the key from the screen was not sent');
});

test('no vision and no OCR text: a spoken question is answered from the words', async (t) => {
  const gw = await startMockGateway({ models: ['txt/a'] });
  t.after(() => gw.close());
  const restore = stubOcr('');
  t.after(restore);
  configure(gw, { GATEWAY_MODELS: 'txt/a' });
  const notices = collectNotices();
  assert.equal(await run(textRequest('explain heaps', { image: true, optionalImage: true })), 'answer from txt/a');
  assert.ok(notices.some((n) => /words only/.test(n.message)));
});

test('no vision and no OCR text: a bare screenshot gets a clear error', async (t) => {
  const gw = await startMockGateway({ models: ['txt/a'] });
  t.after(() => gw.close());
  const restore = stubOcr('');
  t.after(restore);
  configure(gw, { GATEWAY_MODELS: 'txt/a' });
  await assert.rejects(run(textRequest('x', { image: true })), /None of the models can read images/);
});

test('among vision models the fastest known one goes first', async (t) => {
  const gw = await startMockGateway({ models: ['vis/slow', 'vis/fast'], vision: ['vis/slow', 'vis/fast'] });
  t.after(() => gw.close());
  configure(gw, { GATEWAY_MODELS: 'vis/slow,vis/fast' });
  modelHealth.recordLatency(`${gw.url}|vis/slow`, 4000);
  modelHealth.recordLatency(`${gw.url}|vis/fast`, 300);
  assert.equal(await run(textRequest('screen?', { image: true })), 'answer from vis/fast');
});

// ── data leakage and overload ───────────────────────────────────────────
test('a key typed into a question never reaches the provider', async (t) => {
  const gw = await startMockGateway({ models: ['a/one'] });
  t.after(() => gw.close());
  configure(gw, { GATEWAY_MODELS: 'a/one' });
  await run(textRequest('why does my call fail? key=sk-or-v1-0123456789abcdef0123456789abcdef'));
  assert.ok(gw.calls.every((c) => !c.raw.includes('0123456789abcdef')));
});

test('a long session is capped before sending', async (t) => {
  const gw = await startMockGateway({ models: ['a/one'] });
  t.after(() => gw.close());
  configure(gw, { GATEWAY_MODELS: 'a/one', JOBAI_MAX_CONTEXT_CHARS: '6000' });
  const history = [];
  for (let i = 0; i < 60; i++) history.push({ role: i % 2 ? 'model' : 'user', parts: [{ text: `old ${i} ` + 'z'.repeat(800) }] });
  await run(textRequest('latest question', { history }));
  const sent = gw.chatCalls()[0].raw;
  assert.ok(sent.length < 12000, `sent ${sent.length} bytes`);
  assert.ok(sent.includes('latest question'));
});

test('no more than the allowed number of requests run at once', async (t) => {
  const gw = await startMockGateway({ models: ['a/one'], defaultDelay: 120 });
  t.after(() => gw.close());
  configure(gw, { GATEWAY_MODELS: 'a/one', JOBAI_MAX_CONCURRENT_REQUESTS: '2' });
  const answers = await Promise.all(Array.from({ length: 8 }, (_, i) => run(textRequest(`q${i}`))));
  assert.equal(answers.length, 8);
  assert.ok(answers.every((a) => a === 'answer from a/one'), 'all were answered');
  assert.ok(gw.maxInFlight() <= 2, `${gw.maxInFlight()} at once`);
});

// ── discovery ───────────────────────────────────────────────────────────
test('discovered models are remembered, so the next start does not scan again', async (t) => {
  const gw = await startMockGateway({ models: ['a/one', 'b/two', 'c/three'] });
  t.after(() => gw.close());
  configure(gw, { GATEWAY_DISCOVERY: 'true' });
  await llm.refreshDiscoveredModels();
  assert.ok(llm._discoveredModels.length >= 1);
  const scanned = gw.calls.length;
  assert.ok(scanned >= 1, 'the first start tested models');

  gw.reset();
  llm._discoveredModels = null;
  await llm.refreshDiscoveredModels();
  assert.equal(gw.calls.length, 0, 'no test requests the second time');
  assert.ok(llm._discoveredModels.length >= 1);
});

// ── fallback to Gemini, with an error the user sees ─────────────────────
test('when the other AI fails everywhere, Gemini answers and the user is told', async (t) => {
  const gw = await startMockGateway({ models: ['a/one'], status: { 'a/one': 401 } });
  t.after(() => gw.close());
  configure(gw, { GATEWAY_MODELS: 'a/one', GEMINI_API_KEY: 'AIzaSyTestKey0000000000000000000000000' });
  const notices = collectNotices();
  const original = llm._executeRequestOnRoute.bind(llm);
  llm._executeRequestOnRoute = async (request, route) => (route.provider === 'gemini' ? 'gemini answered' : original(request, route));
  t.after(() => { llm._executeRequestOnRoute = original; });

  const request = textRequest('hello');
  request._route = { provider: 'gateway', useDefault: true };
  assert.equal(await run(request), 'gemini answered');
  assert.ok(notices.some((n) => n.level === 'warn' && /Using Gemini/.test(n.message)), JSON.stringify(notices));
});

test('when everything fails the error is shown', async (t) => {
  const gw = await startMockGateway({ models: ['a/one'], status: { 'a/one': 401 } });
  t.after(() => gw.close());
  configure(gw, { GATEWAY_MODELS: 'a/one' });
  const notices = collectNotices();
  await assert.rejects(run(textRequest('hello')));
  assert.ok(notices.some((n) => n.level === 'error'));
});
