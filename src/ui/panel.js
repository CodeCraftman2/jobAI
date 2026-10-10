/* JobAI panel: the single overlay window. Renders transcript, streamed answers,
   follow-ups and the composer, and drives the existing main-process features
   (screenshot, chat message, system-audio listening, skills, settings). */
(function () {
  'use strict';

  const api = window.electronAPI || {};
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  /* ------------------------------------------------------------------ icons */
  const ICONS = {
    chat: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    chats: '<path d="M14 9a2 2 0 0 1-2 2H7l-4 3V4a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2z"/><path d="M18 9h1a2 2 0 0 1 2 2v10l-4-3h-5a2 2 0 0 1-2-2v-1"/>',
    headphones: '<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 15v3a2 2 0 0 1-2 2h-1v-7h1a2 2 0 0 1 2 2zM3 15v3a2 2 0 0 0 2 2h1v-7H5a2 2 0 0 0-2 2z"/>',
    camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
    grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
    sparkles: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
    arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    wave: '<path d="M3 10v4M7 7v10M11 4v16M15 8v8M19 6v12M22 11v2"/>'
  };

  function hydrateIcons(root = document) {
    $$('svg[data-icon]', root).forEach((svg) => {
      const markup = ICONS[svg.dataset.icon];
      if (!markup) return;
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.innerHTML = markup;
    });
  }

  function iconSvg(name) {
    return `<svg class="ic" viewBox="0 0 24 24">${ICONS[name] || ''}</svg>`;
  }

  /* ----------------------------------------------------------------- config */
  const SIZES = { S: [560, 480], M: [760, 620], L: [900, 740], XL: [1000, 860] };

  const voiceFragments = [];
  let autoStarted = false;

  const state = {
    view: 'latest',
    recording: false,
    speechAvailable: true,
    entries: [],
    inFlight: 0,
    errorUntil: 0,
    errorText: '',
    pendingQuestion: '',
    voiceBuffer: '',
    model: 'Gemini',
    size: 'M'
  };

  const el = {
    panel: $('#panel'),
    status: $('#status'),
    statusText: $('#statusText'),
    transcriptSec: $('#transcriptSec'),
    transcriptBody: $('#transcriptBody'),
    answerBody: $('#answerBody'),
    answerQuestion: $('#answerQuestion'),
    answerMeta: $('#answerMeta'),
    listenControls: $('#listenControls'),
    listenBtn: $('#listenBtn'),
    listenLabel: $('#listenLabel'),
    viz: $('#viz'),
    modelName: $('#modelName'),
    input: $('#askInput'),
    send: $('#sendBtn'),
    transSlider: $('#transSlider'),
    transPct: $('#transPct')
  };

  /* --------------------------------------------------------------- markdown */
  function esc(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Models often write inline math as $O(\log n)$. Show it as readable text in a
  // code chip instead of raw LaTeX. Dollar amounts ("$5 and $10") are left alone
  // because a math span can't start or end with a space.
  function texToText(expr) {
    return expr
      .replace(/\\(?:text|mathrm|mathbf|operatorname)\{([^}]*)\}/g, '$1')
      .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)')
      .replace(/\\sqrt\{([^}]*)\}/g, '√($1)')
      .replace(/\\(?:cdot|times)/g, '·')
      .replace(/\\(?:leq?|leqslant)\b/g, '≤')
      .replace(/\\(?:geq?|geqslant)\b/g, '≥')
      .replace(/\\neq?\b/g, '≠')
      .replace(/\\(?:to|rightarrow)\b/g, '→')
      .replace(/\\([A-Za-z]+)/g, '$1')
      .replace(/\^\{([^}]*)\}/g, '^$1')
      .replace(/_\{([^}]*)\}/g, '_$1')
      .replace(/[{}]/g, '');
  }

  function inline(escaped) {
    return escaped
      .replace(/\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g, (_m, expr) => `<code>${texToText(expr)}</code>`)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  }

  function codeBlock(code, lang) {
    const language = (lang || 'text').toLowerCase();
    return `<pre><div class="code-bar"><span>${esc(language)}</span><button class="copy-btn" data-copy>Copy</button></div>` +
      `<code class="language-${esc(language)}">${esc(code)}</code></pre>`;
  }

  const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function splitRow(line) {
    let text = line.trim();
    if (text.startsWith('|')) text = text.slice(1);
    if (text.endsWith('|')) text = text.slice(0, -1);
    return text.split('|').map((cell) => cell.trim());
  }

  function tableHtml(rows) {
    const [head, ...body] = rows;
    const cell = (tag, text) => `<${tag}>${inline(esc(text))}</${tag}>`;
    return '<div class="table-wrap"><table><thead><tr>' + head.map((c) => cell('th', c)).join('') + '</tr></thead><tbody>' +
      body.map((row) => '<tr>' + head.map((_c, n) => cell('td', row[n] || '')).join('') + '</tr>').join('') +
      '</tbody></table></div>';
  }

  function renderMarkdown(source) {
    const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let paragraph = [];
    let list = null;
    let i = 0;

    const flushParagraph = () => {
      if (paragraph.length) {
        out.push(`<p>${inline(esc(paragraph.join(' ')))}</p>`);
        paragraph = [];
      }
    };
    const flushList = () => {
      if (list) {
        out.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(esc(item))}</li>`).join('')}</${list.tag}>`);
        list = null;
      }
    };

    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*```\s*([\w+#-]*)\s*$/);
      if (fence) {
        flushParagraph();
        flushList();
        const code = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          code.push(lines[i]);
          i += 1;
        }
        i += 1; // closing fence (or end of a still-streaming block)
        out.push(codeBlock(code.join('\n'), fence[1]));
        continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        flushList();
        out.push(`<h${heading[1].length}>${inline(esc(heading[2]))}</h${heading[1].length}>`);
        i += 1;
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
        flushParagraph();
        flushList();
        const rows = [splitRow(line)];
        i += 2; // header and its separator row
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        out.push(tableHtml(rows));
        continue;
      }
      const item = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
      if (item) {
        flushParagraph();
        const tag = /\d/.test(item[1]) ? 'ol' : 'ul';
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        list.items.push(item[2]);
        i += 1;
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        i += 1;
        continue;
      }
      flushList();
      paragraph.push(line.trim());
      i += 1;
    }
    flushParagraph();
    flushList();
    return out.join('');
  }

  function highlight(root) {
    if (!window.Prism || !Prism.highlightElement) return;
    $$('pre code', root).forEach((code) => {
      try { Prism.highlightElement(code); } catch (_) { /* highlighting is cosmetic */ }
    });
  }

  /* ----------------------------------------------------------------- status */
  function updateStatus() {
    let mode = 'ready';
    let text = 'Ready';
    if (Date.now() < state.errorUntil) {
      mode = 'error';
      text = state.errorText || 'Error';
    } else if (state.inFlight > 0) {
      mode = 'thinking';
      text = 'Thinking…';
    } else if (state.recording) {
      mode = 'listening';
      text = 'Listening';
    }
    el.status.dataset.state = mode;
    el.statusText.textContent = text;
  }

  function flashError(message) {
    state.errorText = String(message || 'Something went wrong').slice(0, 42);
    state.errorUntil = Date.now() + 5000;
    updateStatus();
    setTimeout(updateStatus, 5100);
  }

  /* ---------------------------------------------------------------- answers */
  function nearBottom(node) {
    return node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  }

  function entryHtml(entry) {
    if (entry.error) {
      return `<div class="err">${esc(entry.error)}</div>`;
    }
    if (!entry.text) {
      return '';
    }
    return renderMarkdown(entry.text);
  }

  function buildEntryEl(entry) {
    const wrap = document.createElement('div');
    wrap.className = 'entry';
    wrap.dataset.id = entry.id;
    const question = document.createElement('div');
    question.className = 'entry-q';
    question.textContent = entry.question || '';
    const body = document.createElement('div');
    body.className = 'md' + (entry.done ? '' : ' streaming');
    body.innerHTML = entryHtml(entry);
    wrap.append(question, body);
    return wrap;
  }

  function visibleEntries() {
    if (state.view === 'all') return state.entries;
    return state.entries.slice(-1);
  }

  function rebuildAnswers() {
    el.answerBody.textContent = '';
    const entries = visibleEntries();
    if (!entries.length) {
      el.answerBody.appendChild(buildEmptyState());
      if (window.applyAppName) window.applyAppName();
    } else {
      entries.forEach((entry) => el.answerBody.appendChild(buildEntryEl(entry)));
      highlight(el.answerBody);
      el.answerBody.scrollTop = state.view === 'all' ? el.answerBody.scrollHeight : 0;
    }
    $('#answerSec').classList.toggle('view-latest', state.view === 'latest');
    updateAnswerHead();
  }

  function buildEmptyState() {
    const box = document.createElement('div');
    box.className = 'empty-state';
    box.id = 'emptyState';
    box.innerHTML = `<div class="empty-icon">${iconSvg('sparkles')}</div>` +
      '<h3>Listening and watching</h3>' +
      '<p><span data-app-name>Code</span> listens to system audio and captures your screen when a question is heard. ' +
      'You can also type a question below, or press <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>S</kbd> to capture the screen yourself.</p>';
    return box;
  }

  function refreshEntry(entry) {
    const existing = $(`.entry[data-id="${CSS.escape(entry.id)}"]`, el.answerBody);
    if (!existing) {
      rebuildAnswers();
      return;
    }
    const stick = state.view === 'all' && nearBottom(el.answerBody);
    const body = $('.md', existing);
    body.className = 'md' + (entry.done ? '' : ' streaming');
    body.innerHTML = entryHtml(entry);
    if (entry.done) highlight(existing);
    if (stick) el.answerBody.scrollTop = el.answerBody.scrollHeight;
    updateAnswerHead();
  }

  function updateAnswerHead() {
    const last = state.entries[state.entries.length - 1];
    el.answerQuestion.textContent = last && last.question ? last.question : '';
    if (!last) {
      el.answerMeta.textContent = '';
      return;
    }
    const parts = [last.model || state.model];
    if (last.done && last.ms) parts.push(`${(last.ms / 1000).toFixed(1)}s`);
    if (last.done && last.withScreen) parts.push('screen');
    el.answerMeta.textContent = parts.join(' · ');
  }

  function findEntry(id) {
    return state.entries.find((entry) => entry.id === id);
  }

  function startEntry(id) {
    let entry = id ? findEntry(id) : null;
    if (entry) return entry;
    const question = state.pendingQuestion || state.voiceBuffer.trim() || (String(id || '').startsWith('img-') ? 'Screen capture' : '');
    state.pendingQuestion = '';
    state.voiceBuffer = '';
    voiceFragments.length = 0;
    entry = { id: id || `local-${Date.now()}`, question, text: '', done: false, ms: 0, error: '' };
    state.entries.push(entry);
    state.inFlight += 1;
    updateStatus();
    rebuildAnswers();
    return entry;
  }

  function finishEntry(entry) {
    if (!entry.done) {
      entry.done = true;
      state.inFlight = Math.max(0, state.inFlight - 1);
    }
    updateStatus();
  }

  function failEntry(message) {
    const pending = [...state.entries].reverse().find((entry) => !entry.done);
    const entry = pending || startEntry(`err-${Date.now()}`);
    entry.error = message || 'Something went wrong';
    finishEntry(entry);
    flashError(entry.error);
    refreshEntry(entry);
  }

  /* ------------------------------------------------------------- transcript */
  function addTranscript(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    const empty = $('.empty', el.transcriptBody);
    if (empty) empty.remove();
    $$('.t-line.latest', el.transcriptBody).forEach((line) => line.classList.remove('latest'));

    const row = document.createElement('div');
    row.className = 't-line latest';
    const time = document.createElement('span');
    time.className = 't-time';
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const body = document.createElement('span');
    body.className = 't-text';
    body.textContent = clean;
    row.append(time, body);
    el.transcriptBody.appendChild(row);
    while (el.transcriptBody.children.length > 80) el.transcriptBody.firstChild.remove();
    el.transcriptBody.scrollTop = el.transcriptBody.scrollHeight;

    voiceFragments.push(clean);
    if (voiceFragments.length > 2) voiceFragments.shift();
    state.voiceBuffer = voiceFragments.join(' ');
  }

  function transcriptHint() {
    if (!state.speechAvailable) return 'Speech is not set up. Open Settings to turn on listening.';
    return state.recording
      ? 'Listening for questions. What the other side says shows up here.'
      : 'Auto listening is off. Press Start to listen again.';
  }

  function resetTranscript() {
    el.transcriptBody.innerHTML = '';
    const hint = document.createElement('p');
    hint.className = 'empty';
    hint.textContent = transcriptHint();
    el.transcriptBody.appendChild(hint);
    state.voiceBuffer = '';
    voiceFragments.length = 0;
  }

  /* ------------------------------------------------------------------ modes */
  /* --------------------------------------------------------------- composer */
  function ask(text, label) {
    const clean = String(text || '').trim();
    if (!clean || !api.sendChatMessage) return;
    state.pendingQuestion = label || clean;
    api.sendChatMessage(clean);
  }

  function submitInput() {
    const text = el.input.value;
    if (!text.trim()) return;
    el.input.value = '';
    el.send.disabled = true;
    ask(text);
  }

  /* ---------------------------------------------------- system-audio listen */
  let audio = null;

  async function getSystemAudioStream() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (_) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: { mandatory: { chromeMediaSource: 'desktop' } }
      });
    }
    stream.getVideoTracks().forEach((track) => {
      track.stop();
      stream.removeTrack(track);
    });
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('No system audio track available');
    }
    return stream;
  }

  async function startCapture() {
    stopCapture();
    try {
      const stream = await getSystemAudioStream();
      const context = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 128;
      const node = context.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (event) => {
        if (!state.recording || !api.sendAudioChunk) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);
        for (let n = 0; n < input.length; n += 1) {
          const sample = Math.max(-1, Math.min(1, input[n]));
          pcm[n] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        }
        api.sendAudioChunk(pcm.buffer);
      };
      source.connect(analyser);
      source.connect(node);
      node.connect(context.destination);
      audio = { stream, context, node, analyser, raf: 0 };
      drawViz();
    } catch (error) {
      flashError(error.message || 'Could not capture system audio');
      if (api.stopSpeechRecognition) api.stopSpeechRecognition().catch(() => {});
    }
  }

  function stopCapture() {
    if (!audio) return;
    try {
      cancelAnimationFrame(audio.raf);
      audio.node.disconnect();
      audio.node.onaudioprocess = null;
      audio.stream.getTracks().forEach((track) => track.stop());
      audio.context.close().catch(() => {});
    } catch (_) { /* already torn down */ }
    audio = null;
    drawViz();
  }

  function drawViz() {
    const canvas = el.viz;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(40, Math.floor(rect.width * ratio));
    const height = Math.max(20, Math.floor(rect.height * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);

    const bars = Math.floor(width / (5 * ratio));
    const data = audio ? new Uint8Array(audio.analyser.frequencyBinCount) : null;
    if (data) audio.analyser.getByteFrequencyData(data);
    for (let n = 0; n < bars; n += 1) {
      const level = data ? data[Math.floor((n / bars) * data.length * 0.7)] / 255 : 0;
      const barHeight = Math.max(2 * ratio, level * height * 0.95);
      ctx.fillStyle = data ? `rgba(34,197,94,${0.35 + level * 0.65})` : 'rgba(255,255,255,0.14)';
      ctx.fillRect(n * 5 * ratio, (height - barHeight) / 2, 3 * ratio, barHeight);
    }
    if (audio) audio.raf = requestAnimationFrame(drawViz);
  }

  function setRecording(on) {
    state.recording = on;
    el.listenControls.classList.toggle('live', on);
    el.listenBtn.classList.toggle('on', on);
    el.listenBtn.querySelector('svg').innerHTML = ICONS[on ? 'stop' : 'mic'];
    el.listenLabel.textContent = on ? 'Stop' : 'Start';
    const hint = $('.empty', el.transcriptBody);
    if (hint) hint.textContent = transcriptHint();
    updateStatus();
  }

  /* ------------------------------------------------------------------ sizes */
  function applySize(name, persist) {
    const preset = SIZES[name] || SIZES.M;
    state.size = SIZES[name] ? name : 'M';
    $$('#sizeSeg .seg-btn').forEach((button) => button.classList.toggle('active', button.dataset.size === state.size));
    const maxHeight = Math.max(360, (window.screen.availHeight || 900) - 40);
    if (api.resizeWindow) api.resizeWindow(preset[0], Math.min(preset[1], maxHeight));
    if (persist) {
      try { localStorage.setItem('jobai.panel.size', state.size); } catch (_) { /* storage unavailable */ }
    }
    // S and M show only the latest conversation; the transcript and the
    // Latest/All switch belong to L and XL.
    const compact = state.size === 'S' || state.size === 'M';
    $('#transcriptSec').hidden = compact;
    $('#viewSeg').hidden = compact;
    if (compact && state.view !== 'latest') {
      state.view = 'latest';
      $$('#viewSeg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === 'latest'));
      rebuildAnswers();
    }
    setTimeout(drawViz, 120);
  }

  /* ------------------------------------------------------------ transparency */
  // Same idea as Pluely: 0-100 %, higher means more see-through, default 10 %.
  const TRANSPARENCY_KEY = 'jobai.panel.transparency';

  function applyTransparency(value, persist) {
    const pct = Math.max(0, Math.min(100, Math.round(Number(value))));
    const percent = Number.isFinite(pct) ? pct : 10;
    document.documentElement.style.setProperty('--a', String((100 - percent) / 100));
    el.transSlider.value = String(percent);
    el.transSlider.style.setProperty('--fill', `${percent}%`);
    el.transPct.textContent = `${percent}%`;
    if (persist) {
      try { localStorage.setItem(TRANSPARENCY_KEY, String(percent)); } catch (_) { /* storage unavailable */ }
    }
  }

  function loadTransparency() {
    let stored = 10;
    try {
      const raw = localStorage.getItem(TRANSPARENCY_KEY);
      if (raw !== null) stored = parseInt(raw, 10);
    } catch (_) { /* default applies */ }
    applyTransparency(stored, false);
  }

  /* ---------------------------------------------------------------- wiring */
  function bindUi() {
    $$('#viewSeg .seg-btn').forEach((button) => button.addEventListener('click', () => {
      state.view = button.dataset.view;
      $$('#viewSeg .seg-btn').forEach((b) => b.classList.toggle('active', b === button));
      rebuildAnswers();
    }));
    $$('#sizeSeg .seg-btn').forEach((button) => button.addEventListener('click', () => applySize(button.dataset.size, true)));
    el.transSlider.addEventListener('input', () => applyTransparency(el.transSlider.value, true));

    $('#settingsBtn').addEventListener('click', () => api.showSettings && api.showSettings());
    $('#hideBtn').addEventListener('click', () => api.hideAllWindows && api.hideAllWindows());
    $('#clearBtn').addEventListener('click', () => api.clearSessionMemory && api.clearSessionMemory());
    el.listenBtn.addEventListener('click', async () => {
      if (!api.startSpeechRecognition) return;
      if (state.recording) await api.stopSpeechRecognition();
      else await api.startSpeechRecognition();
    });

    el.input.addEventListener('input', () => { el.send.disabled = !el.input.value.trim(); });
    el.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submitInput();
      } else if (event.key === 'Escape') {
        el.input.blur();
      }
    });
    el.send.addEventListener('click', submitInput);

    el.answerBody.addEventListener('click', (event) => {
      const button = event.target.closest('[data-copy]');
      if (!button) return;
      const code = button.closest('pre').querySelector('code');
      if (api.copyToClipboard) api.copyToClipboard(code.textContent);
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, 1200);
    });
  }

  function bindIpc() {
    if (!api.onTranscriptionReceived) return;

    api.onTranscriptionReceived((_e, data) => { if (data && data.text) addTranscript(data.text); });

    api.onTranscriptionLlmResponseStart((_e, data) => {
      startEntry(data && data.messageId);
    });

    api.onTranscriptionLlmResponseChunk((_e, data) => {
      if (!data || !data.delta) return;
      const entry = findEntry(data.messageId) || startEntry(data.messageId);
      entry.text += data.delta;
      refreshEntry(entry);
    });

    api.onTranscriptionLlmResponse((_e, data) => {
      if (!data) return;
      const id = data.messageId || (data.metadata && data.metadata.messageId);
      const entry = findEntry(id) || startEntry(id);
      if (typeof data.response === 'string' && data.response) entry.text = data.response;
      const ms = data.metadata && data.metadata.processingTime;
      if (ms) entry.ms = ms;
      const md = data.metadata || {};
      if (md.model) {
        entry.model = md.model;
        showModel(md.model, md.provider); // the model that really answered, fallback included
      }
      entry.withScreen = !!(md.withScreenshot || md.isImageAnalysis);
      finishEntry(entry);
      refreshEntry(entry);
    });

    api.onLlmError((_e, data) => failEntry(data && data.error));
    if (api.onLlmNotice) api.onLlmNotice((_e, data) => flashError(data && data.message));
    api.onOcrError((_e, data) => failEntry(data && data.error));

    api.onRecordingStarted(() => {
      setRecording(true);
      startCapture();
    });
    api.onRecordingStopped(() => {
      setRecording(false);
      stopCapture();
    });
    api.onSpeechError((_e, data) => flashError(data && (data.error && data.error.message || data.error)));
    api.onSpeechAvailability((_e, data) => applySpeechAvailability(!!(data && data.available)));
    api.onMainWindowShown(() => loadSpeechAvailability());

    api.onInteractionModeChanged((_e, interactive) => el.panel.classList.toggle('passive', !interactive));
    api.onSessionCleared(() => {
      state.entries = [];
      state.inFlight = 0;
      state.pendingQuestion = '';
      resetTranscript();
      rebuildAnswers();
      updateStatus();
    });
    if (api.receive) api.receive('focus-input', () => el.input.focus());
  }

  function applySpeechAvailability(available) {
    state.speechAvailable = available;
    el.listenBtn.disabled = !available;
    el.listenBtn.title = available
      ? 'Stop or start both listening and automatic screen capture. Start or stop: Ctrl+Shift+M. Stop only: Ctrl+Shift+X'
      : 'Speech is not set up. Open Settings to turn on listening.';
    el.listenControls.style.opacity = available ? '' : '0.5';
    const hint = $('.empty', el.transcriptBody);
    if (hint) hint.textContent = transcriptHint();
    maybeAutoStart();
  }

  // Listening starts by itself, once per launch. Stopping it is the user's choice
  // and is respected until the next launch.
  function maybeAutoStart() {
    if (autoStarted || !state.speechAvailable || state.recording || !api.startSpeechRecognition) return;
    autoStarted = true;
    Promise.resolve(api.startSpeechRecognition()).catch(() => {});
  }

  async function loadSpeechAvailability() {
    try {
      applySpeechAvailability(!!(await api.getSpeechAvailability()));
    } catch (_) {
      applySpeechAvailability(false);
    }
  }

  function showModel(model, provider) {
    state.model = model;
    $('span', el.modelName).textContent = model;
    el.modelName.title = `Answering model${provider ? ' (' + provider + ')' : ''}`;
  }

  // Show the model that answers in the current mode (Interview vs Coding).
  async function refreshModelLabel() {
    try {
      const active = api.getActiveModel ? await api.getActiveModel() : null;
      let model = active && active.model;
      if (!model) {
        const status = await api.getGeminiStatus();
        model = status && status.config && status.config.model;
      }
      if (model) {
        showModel(model, active && active.provider);
        updateAnswerHead();
      }
    } catch (_) { /* label stays generic */ }
  }

  async function loadInitialState() {
    try {
      const stats = await api.getWindowStats();
      if (stats && typeof stats.isInteractive === 'boolean') el.panel.classList.toggle('passive', !stats.isInteractive);
    } catch (_) { /* assume interactive */ }

    await refreshModelLabel();
    // The answering model depends on the mode, so follow mode changes.
    // Settings may have changed the model list (Auto-pick, Test models).
    window.addEventListener('focus', () => refreshModelLabel());
    if (api.onSkillChanged) api.onSkillChanged(() => refreshModelLabel());
    if (api.onSkillUpdated) api.onSkillUpdated(() => refreshModelLabel());

    await loadSpeechAvailability();
  }

  function init() {
    try {
      if (window.Prism && Prism.plugins && Prism.plugins.autoloader) {
        Prism.plugins.autoloader.languages_path = './node_modules/prismjs/components/';
      }
    } catch (_) { /* highlighting is cosmetic */ }
    hydrateIcons();
    loadTransparency();
    bindUi();
    bindIpc();
    setRecording(false);
    rebuildAnswers();
    drawViz();

    let size = 'M';
    try { size = localStorage.getItem('jobai.panel.size') || 'M'; } catch (_) { /* default */ }
    applySize(size, false);

    loadInitialState();
    if (api.notifyMainWindowReady) api.notifyMainWindowReady();
    window.addEventListener('resize', drawViz);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
