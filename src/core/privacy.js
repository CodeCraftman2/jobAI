/**
 * What may leave the machine, and how much of it.
 *
 * Everything sent to an AI provider passes through sanitizeRequest():
 *   - secrets (API keys, tokens, private keys, passwords) are replaced with
 *     [redacted], so a key visible on screen or in a pasted snippet is not
 *     sent on to a third party;
 *   - each text part and the whole request are capped, newest content kept,
 *     so a long session cannot grow into a huge upload;
 *   - at most MAX_IMAGES images go along, the newest ones.
 * Limits can be changed with JOBAI_MAX_CONTEXT_CHARS / JOBAI_MAX_PART_CHARS.
 */
const REDACTED = '[redacted]';

const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],                       // OpenAI, Anthropic, OpenRouter
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],                      // Google
  [/\bAQ\.[A-Za-z0-9_-]{30,}/g, REDACTED],                      // Google (newer format)
  [/\bnvapi-[A-Za-z0-9_-]{20,}/g, REDACTED],                    // NVIDIA
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED],    // GitHub
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],                // Slack
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],                          // AWS access key id
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REDACTED], // JWT
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{20,}/gi, `$1 ${REDACTED}`]
];

// name = value for secret-looking names. The value must look like a key
// (16+ key characters including a digit) so ordinary code such as
// "token = tokens[i]" is left alone.
const ASSIGNMENT = /\b((?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|token|password|passwd|pwd)\s*[:=]\s*)(['"]?)([A-Za-z0-9_\-+/=.]{16,})\2/gi;

function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  out = out.replace(ASSIGNMENT, (match, lead, quote, value) => (/\d/.test(value) ? `${lead}${quote}${REDACTED}${quote}` : match));
  return out;
}

/** Keep the start and the end of a long text, dropping the middle. The result is never longer than `max`. */
function limitText(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text;
  const markerFor = (omitted) => `
…[${omitted} characters omitted]…
`;
  // The marker takes room too, so size it for the largest possible count first.
  const room = Math.max(0, max - markerFor(text.length).length);
  const head = Math.floor(room * 0.6);
  const tail = room - head;
  return `${text.slice(0, head)}${markerFor(text.length - room)}${tail ? text.slice(text.length - tail) : ''}`;
}

function numberFromEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MAX_IMAGES = 2;

/**
 * Clean a Gemini-shaped request in place and say what was done. Idempotent.
 * @returns {{redactions:number, truncatedParts:number, droppedMessages:number, droppedImages:number}}
 */
function sanitizeRequest(request) {
  const stats = { redactions: 0, truncatedParts: 0, droppedMessages: 0, droppedImages: 0 };
  if (!request || !Array.isArray(request.contents)) return stats;
  const maxPart = numberFromEnv('JOBAI_MAX_PART_CHARS', 12000);
  const maxTotal = numberFromEnv('JOBAI_MAX_CONTEXT_CHARS', 30000);

  for (const content of request.contents) {
    for (const part of content.parts || []) {
      if (typeof part.text !== 'string') continue;
      const cleaned = redactSecrets(part.text);
      if (cleaned !== part.text) stats.redactions++;
      const limited = limitText(cleaned, maxPart);
      if (limited !== cleaned) stats.truncatedParts++;
      part.text = limited;
    }
  }

  // Keep the newest messages that fit the budget; the last one always stays.
  const size = (c) => (c.parts || []).reduce((n, p) => n + (typeof p.text === 'string' ? p.text.length : 0), 0);
  let budget = maxTotal;
  const kept = [];
  for (let i = request.contents.length - 1; i >= 0; i--) {
    const c = request.contents[i];
    const s = size(c);
    if (kept.length === 0 || s <= budget) {
      kept.unshift(c);
      budget -= s;
    } else {
      break;
    }
  }
  // A conversation should open with the user's turn.
  while (kept.length > 1 && kept[0].role === 'model') kept.shift();
  stats.droppedMessages = request.contents.length - kept.length;
  request.contents = kept;

  // Newest images only.
  let seen = 0;
  for (let i = request.contents.length - 1; i >= 0; i--) {
    const parts = request.contents[i].parts || [];
    for (let j = parts.length - 1; j >= 0; j--) {
      if (!parts[j].inlineData) continue;
      if (++seen > MAX_IMAGES) { parts.splice(j, 1); stats.droppedImages++; }
    }
  }
  return stats;
}

module.exports = { redactSecrets, limitText, sanitizeRequest, MAX_IMAGES, REDACTED };
