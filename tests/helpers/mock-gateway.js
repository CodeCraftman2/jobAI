// A stand-in for any OpenAI-style multi-model gateway (OpenRouter, Kilo, ...),
// with switches for the behaviours the app has to cope with. Everything the
// "provider" receives is recorded, so tests can check what actually left the app.
const http = require('http');
const { PROBE_QUESTION } = require('../../src/core/vision-probe');

/**
 * @param {object} opts
 * @param {string[]} opts.models            model ids listed by GET /models
 * @param {string[]} [opts.vision]          models that really read images
 * @param {boolean} [opts.metadata=true]    include input_modalities in /models
 * @param {object}  [opts.status]           model -> HTTP status to fail with
 * @param {object}  [opts.delay]            model -> ms before answering
 * @param {number}  [opts.defaultDelay=0]
 */
async function startMockGateway(opts) {
  const vision = new Set(opts.vision || []);
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      if (req.url.endsWith('/models')) {
        const data = opts.models.map((id) => (opts.metadata === false
          ? { id }
          : { id, architecture: { input_modalities: vision.has(id) ? ['text', 'image'] : ['text'], output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } }));
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ data }));
      }
      const body = JSON.parse(raw || '{}');
      const hasImage = raw.includes('image_url');
      const isProbe = raw.includes(PROBE_QUESTION);
      calls.push({ model: body.model, hasImage, isProbe, stream: !!body.stream, raw });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const wait = (opts.delay && opts.delay[body.model]) ?? opts.defaultDelay ?? 0;
        if (wait) await new Promise((r) => setTimeout(r, wait));
        const status = opts.status && opts.status[body.model];
        if (status) { res.statusCode = status; return res.end(JSON.stringify({ error: { message: `forced ${status}` } })); }
        if (hasImage && !vision.has(body.model)) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: { message: 'this model does not support images' } }));
        }
        const text = isProbe ? 'Red' : `answer from ${body.model}`;
        if (body.stream) {
          res.setHeader('content-type', 'text/event-stream');
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
      } finally {
        inFlight--;
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    chatCalls: () => calls.filter((c) => !c.isProbe),
    probeCalls: () => calls.filter((c) => c.isProbe),
    maxInFlight: () => maxInFlight,
    reset: () => { calls.length = 0; maxInFlight = 0; },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); })
  };
}

module.exports = { startMockGateway };
