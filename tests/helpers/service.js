// Loads the real LLM service pointed at a mock gateway, with a throwaway data
// folder, no Gemini key and OCR stubbed, so every test starts from a clean state.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.LOG_LEVEL = 'error';
process.env.JOBAI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jobai-test-'));

const root = path.join(__dirname, '..', '..');
const llm = require(path.join(root, 'src', 'services', 'llm.service'));
const ocr = require(path.join(root, 'src', 'services', 'ocr.service'));
const modelHealth = require(path.join(root, 'src', 'core', 'model-health'));

const USER_SHOT = Buffer.from('USER-SCREENSHOT-BYTES-0123456789');
const USER_SHOT_B64 = USER_SHOT.toString('base64');

function configure(gateway, extra = {}) {
  const keys = ['GEMINI_API_KEY', 'GATEWAY_API_KEY', 'GATEWAY_BASE_URL', 'GATEWAY_FORMAT', 'GATEWAY_AUTH', 'GATEWAY_MODELS',
    'GATEWAY_DISCOVERY', 'GATEWAY_FREE_ONLY', 'LLM_PROVIDER', 'LLM_ROUTING', 'JOBAI_MAX_CONCURRENT_REQUESTS',
    'JOBAI_MAX_CONTEXT_CHARS', 'JOBAI_MAX_PART_CHARS', 'JOBAI_OCR_FALLBACK'];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, {
    GATEWAY_API_KEY: 'test-key-1234567890',
    GATEWAY_BASE_URL: gateway.url,
    GATEWAY_FORMAT: 'openai',
    GATEWAY_AUTH: 'bearer',
    GATEWAY_DISCOVERY: 'false',
    LLM_PROVIDER: 'gateway',
    LLM_ROUTING: 'off'
  }, extra);
  modelHealth.reset();
  fs.rmSync(path.join(process.env.JOBAI_DATA_DIR, 'model-health.json'), { force: true });
  llm._cooldowns = new Map();
  llm._catalog = null;
  llm._discoveredModels = null;
  llm._warming = true; // no background warm-up during tests
  llm.noticeHandler = null;
  llm.initializeClient();
  llm._warming = true;
  gateway.reset();
  return llm;
}

/** Collect notices the user would see. */
function collectNotices() {
  const notices = [];
  llm.noticeHandler = (n) => notices.push(n);
  return notices;
}

/** A Gemini-shaped request, like the one the app builds for a question. */
function textRequest(text, { history = [], image = false, optionalImage = false } = {}) {
  const request = {
    contents: [
      ...history,
      { role: 'user', parts: [{ text }, ...(image ? [{ inlineData: { data: USER_SHOT_B64, mimeType: 'image/png' } }] : [])] }
    ],
    generationConfig: { maxOutputTokens: 256 }
  };
  llm.tagRoute(request, 'interview');
  if (optionalImage) Object.defineProperty(request, '_imageOptional', { value: true, enumerable: false });
  return request;
}

function stubOcr(text) {
  const original = { recognize: ocr.recognize, enabled: ocr.enabled };
  ocr.recognize = async () => text;
  ocr.enabled = () => true;
  return () => Object.assign(ocr, original);
}

module.exports = { llm, ocr, modelHealth, configure, collectNotices, textRequest, stubOcr, USER_SHOT_B64 };
