// Turns a pasted `curl` command into the pieces Settings needs for a custom
// provider: base URL, API key, credential kind, API format and model.
(function (root) {
  // Shell-style split: handles '...', "...", backslashes and line continuations
  // (\ for bash, ^ for cmd, ` for PowerShell).
  function tokenize(text) {
    const src = String(text || '').replace(/(\\|\^|`)\r?\n/g, ' ');
    const tokens = [];
    let cur = '';
    let has = false;
    let quote = null;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === quote) { quote = null; continue; }
        if (c === '\\' && quote === '"' && i + 1 < src.length && /["\\$`]/.test(src[i + 1])) {
          cur += src[++i];
          continue;
        }
        cur += c;
      } else if (c === '"' || c === "'") {
        quote = c; has = true;
      } else if (/\s/.test(c)) {
        if (has || cur) { tokens.push(cur); cur = ''; has = false; }
      } else if (c === '\\' && i + 1 < src.length) {
        cur += src[++i]; has = true;
      } else {
        cur += c; has = true;
      }
    }
    if (has || cur) tokens.push(cur);
    return tokens;
  }

  function parseCurl(text) {
    const tokens = tokenize(text);
    if (!tokens.length) return { ok: false, error: 'Paste a curl command first.' };

    let url = '';
    const headers = {};
    let body = '';
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '-H' || t === '--header') {
        const h = tokens[++i] || '';
        const idx = h.indexOf(':');
        if (idx > 0) headers[h.slice(0, idx).trim().toLowerCase()] = h.slice(idx + 1).trim();
      } else if (/^(-d|--data|--data-raw|--data-binary|--json)$/.test(t)) {
        body = tokens[++i] || '';
      } else if (t === '--url') {
        url = tokens[++i] || '';
      } else if (/^https?:\/\//i.test(t) && !url) {
        url = t;
      }
    }
    if (!url) return { ok: false, error: 'No URL found in the curl command.' };

    let u;
    try { u = new URL(url); } catch (_) { return { ok: false, error: 'The URL in the curl command is not valid.' }; }

    let apiKey = '';
    let auth = '';
    if (headers['x-api-key']) {
      apiKey = headers['x-api-key'];
      auth = 'x-api-key';
    } else if (headers['authorization']) {
      apiKey = headers['authorization'].replace(/^bearer\s+/i, '');
      auth = 'bearer';
    }

    let model = '';
    try { model = JSON.parse(body).model || ''; } catch (_) { /* body is optional */ }

    // Settings stores the base URL; the app appends the path itself, so the
    // path also tells us which API format the endpoint speaks.
    let format = '';
    let basePath = u.pathname.replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(basePath)) { format = 'openai'; basePath = basePath.replace(/\/chat\/completions$/, ''); }
    else if (/\/messages$/.test(basePath)) { format = 'anthropic'; basePath = basePath.replace(/\/messages$/, ''); }
    else if (/\/(responses|completions)$/.test(basePath)) {
      return { ok: false, error: 'Only /chat/completions and /messages endpoints are supported.' };
    }
    const baseUrl = u.origin + basePath;

    // $VAR / %VAR% left in the command means the real key was not pasted.
    const placeholder = /^\$|^%.*%$|^<.*>$|^your[_-]/i.test(apiKey);
    return {
      ok: true,
      baseUrl,
      apiKey: placeholder ? '' : apiKey,
      auth,
      format,
      model,
      warning: !apiKey
        ? 'No API key header found. Add one with -H "Authorization: Bearer ..." or -H "x-api-key: ...".'
        : placeholder
          ? 'The key looks like a variable (' + apiKey + '). Paste the real key into the API key field.'
          : ''
    };
  }

  const api = { parseCurl, tokenize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CurlParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
