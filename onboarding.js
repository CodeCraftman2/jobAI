/* eslint-disable no-undef */
/**
 * Onboarding wizard controller.
 *
 * Drives the 5-step flow rendered in onboarding.html and persists
 * everything via the electronAPI bridge exposed by preload.js:
 *
 *   1. Welcome
 *   2. Gemini key (required) + optional OpenRouter key / curl command
 *   3. Speech provider choice (Whisper / Azure / Skip) + Whisper settings
 *   4. Whisper detect + (optional) install — only shown when whisper
 *   5. Star-the-repo prompt + summary
 */

(function () {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // Quote the executable portion of a command string if it contains spaces.
  // This keeps Windows user profile paths (e.g. C:\Users\CANDAN SINGH\...) intact.
  function quoteCommandIfNeeded(cmd) {
    if (!cmd) return cmd;
    const firstSpace = cmd.indexOf(' ');
    if (firstSpace === -1) return cmd;
    const exe = cmd.slice(0, firstSpace);
    const rest = cmd.slice(firstSpace + 1);
    if (exe.startsWith('"') || rest.startsWith('"')) return cmd;
    return `"${exe}" ${rest}`;
  }

  const screens = $$('.screen');
  const stepBadge = $('#stepBadge');
  const backBtn = $('#backBtn');
  const nextBtn = $('#nextBtn');
  const skipBtn = $('#skipBtn');
  const nav = $('#wizard .nav'); // the centered nav container

  // ── State ─────────────────────────────────────────────────────────
  const state = {
    step: 0,
    geminiKey: '',
    geminiConfigured: false, // a key already exists in .env from a prior run
    gatewayKey: '',
    gatewayConfigured: false, // an other-AI key already exists in .env
    curlText: '',
    activeSkill: 'dsa',
    codingLanguage: 'cpp',
    autoScreen: true,
    speechProvider: 'whisper', // 'whisper' | 'azure' | 'skip' - Whisper is the default
    whisperModel: 'small',
    whisperLanguage: 'auto',
    whisperDevice: 'auto',
    whisperCaptureMode: 'vad',
    whisperSegmentMs: '4000',
    azureKey: '',
    azureRegion: '',
    whisperCmd: null,
    whisperDetected: false,
    skippingWhisper: false,
    ocrChoice: null, // 'now' | 'later'
    ocrInstalled: false,
    ocrDownloading: false,
    modelDownloadChoice: null, // 'now' | 'later'
    modelDownloading: false,
    modelDownloaded: false,
    finished: false,
  };

  // Screens are: welcome → apikey → speech → whisper? → finish
  // The whisper screen is only visited if state.speechProvider === 'whisper'
  const stepScreens = ['welcome', 'apikey', 'speech'];

  // ── Step rendering ────────────────────────────────────────────────
  function totalSteps() {
    return computeScreenOrder().length;
  }

  function refreshStepper() {
    const total = totalSteps();
    const current = state.step + 1;
    stepBadge.textContent = `Step ${current} of ${total}`;

    // The number of screens depends on the speech choice (Whisper adds two),
    // so keep one dot per screen instead of the four in the markup.
    const stepper = $('#stepper');
    while (stepper.children.length < total) {
      const dot = document.createElement('div');
      dot.className = 'step-dot';
      stepper.appendChild(dot);
    }
    while (stepper.children.length > total) stepper.lastElementChild.remove();

    Array.from(stepper.children).forEach((dot, i) => {
      dot.classList.remove('active', 'done');
      if (i < state.step) dot.classList.add('done');
      else if (i === state.step) dot.classList.add('active');
    });
  }

  function showScreen(name) {
    screens.forEach((s) => {
      s.classList.toggle('active', s.dataset.screen === name);
    });
    // Welcome screen uses an inline hero CTA — hide the regular nav row.
    const wizardEl = document.getElementById('wizard');
    if (wizardEl) {
      wizardEl.classList.toggle('welcome-active', name === 'welcome');
    }
    refreshStepper();
    backBtn.style.visibility = state.step === 0 ? 'hidden' : 'visible';
    // Reset next button state unless we're actively downloading a model
    if (name !== 'model-download' || !state.modelDownloading) {
      nextBtn.disabled = false;
      nextBtn.classList.remove('success');
      nextBtn.classList.add('primary');
    }
    // The primary action label changes by step
    if (name === 'welcome') nextBtn.innerHTML = 'Get started <i class="fas fa-arrow-right"></i>';
    else if (name === 'finish') nextBtn.innerHTML = 'Finish <i class="fas fa-check"></i>';
    else if (name === 'whisper') nextBtn.innerHTML = 'Continue <i class="fas fa-arrow-right"></i>';
    else nextBtn.innerHTML = 'Continue <i class="fas fa-arrow-right"></i>';
  }

  function navigate(direction) {
    const order = computeScreenOrder();
    const idx = order.indexOf(currentScreenName());
    const next = direction === 'next' ? idx + 1 : idx - 1;
    if (next < 0 || next >= order.length) return;
    state.step = orderScreenToStep(order[next]);
    showScreen(order[next]);
  }

  function currentScreenName() {
    const active = Array.from(screens).find((s) => s.classList.contains('active'));
    return active ? active.dataset.screen : 'welcome';
  }

  // Order depends on choices — e.g. whisper path inserts the install screen.
  function computeScreenOrder() {
    const out = ['welcome', 'apikey', 'preferences', 'ocr', 'speech'];
    if (state.speechProvider === 'whisper') out.push('whisper');
    if (state.speechProvider === 'whisper') out.push('model-download');
    out.push('finish');
    return out;
  }

  // Map a screen name to its position in the stepper (0..n).
  function orderScreenToStep(name) {
    return computeScreenOrder().indexOf(name);
  }

  // ── Validation gates before "Continue" ───────────────────────────
  function canAdvance() {
    const name = currentScreenName();
    switch (name) {
      case 'welcome':
        return true;
      case 'apikey':
        // A key already in .env is enough — don't force a re-entry.
        return llmKeyReady();
      case 'speech':
        if (state.speechProvider === 'azure') {
          return !!state.azureKey.trim() && !!state.azureRegion.trim();
        }
        return !!state.speechProvider;
      case 'whisper':
        // Allow advancing whether whisper is detected OR user skipped
        return state.whisperDetected || state.skippingWhisper;
      case 'ocr':
        return (!!state.ocrChoice || state.ocrInstalled) && !state.ocrDownloading;
      case 'model-download':
        return !!state.modelDownloadChoice && !state.modelDownloading;
      case 'finish':
        return true;
      default:
        return true;
    }
  }

  // ── Wire up: API key ──────────────────────────────────────────────
  const geminiInput = $('#geminiKey');
  const toggleVis = $('#toggleVis');
  const keyStatus = $('#keyStatus');

  function setKeyStatus(state_, text) {
    keyStatus.className = `status-pill ${state_}`;
    keyStatus.style.display = 'inline-flex';
    const icon = keyStatus.querySelector('i');
    const txt = keyStatus.querySelector('.text');
    if (state_ === 'testing') {
      icon.className = 'fas fa-circle-notch fa-spin';
    } else if (state_ === 'success') {
      icon.className = 'fas fa-check-circle';
    } else if (state_ === 'error') {
      icon.className = 'fas fa-circle-xmark';
    } else {
      icon.className = 'fas fa-circle-info';
    }
    txt.textContent = text;
  }

  const gatewayInput = $('#gatewayKey');
  const toggleVisGateway = $('#toggleVisGateway');
  const curlInput = $('#curlInput');

  // Gemini is the one required key: it answers interview questions and is the
  // fallback when any other AI fails.
  function llmKeyReady() {
    return !!(state.geminiKey.trim() || state.geminiConfigured);
  }

  function refreshKeyStatus() {
    if (state.geminiKey) setKeyStatus('idle', 'Key entered');
    else if (state.geminiConfigured) setKeyStatus('success', 'Already configured — click Continue');
    else keyStatus.style.display = 'none';
  }

  geminiInput.addEventListener('input', () => {
    state.geminiKey = geminiInput.value.trim();
    refreshKeyStatus();
  });
  gatewayInput.addEventListener('input', () => { state.gatewayKey = gatewayInput.value.trim(); });
  curlInput.addEventListener('input', () => { state.curlText = curlInput.value; });

  function bindVisibilityToggle(input, button) {
    button.addEventListener('click', () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      button.innerHTML = showing
        ? '<i class="fas fa-eye"></i>'
        : '<i class="fas fa-eye-slash"></i>';
    });
  }
  bindVisibilityToggle(geminiInput, toggleVis);
  bindVisibilityToggle(gatewayInput, toggleVisGateway);

  // Settings for the optional other AI: a pasted curl command fills the URL,
  // key, credential kind, format and model; a typed key wins over the curl's.
  // With no model named, the app discovers working ones itself.
  function buildLlmPayload() {
    const payload = { llmProvider: 'gemini' };
    if (state.geminiKey) payload.geminiKey = state.geminiKey;

    let key = state.gatewayKey;
    let model = '';
    if (state.curlText.trim()) {
      const r = window.CurlParser.parseCurl(state.curlText);
      if (!r.ok) return { error: r.error };
      payload.gatewayBaseUrl = /(^|\/\/)api\.anthropic\.com/.test(r.baseUrl) ? '' : r.baseUrl;
      payload.gatewayAuth = r.auth || '';
      payload.gatewayFormat = r.format || '';
      key = key || r.apiKey;
      model = r.model;
      if (model) payload.gatewayModels = model;
    }
    if (key) {
      payload.gatewayKey = key;
      payload.gatewayDiscovery = !model;
    }
    return { payload, hasOtherAi: !!(key || state.gatewayConfigured) };
  }

  // Save the keys, then make a tiny request to each configured AI.
  const testKeyBtn = $('#testKeyBtn');
  testKeyBtn.addEventListener('click', async () => {
    if (!llmKeyReady()) {
      setKeyStatus('error', 'Enter a Gemini API key first');
      return;
    }
    if (!window.electronAPI) return;

    const built = buildLlmPayload();
    if (built.error) { setKeyStatus('error', built.error); return; }

    const originalHtml = testKeyBtn.innerHTML;
    testKeyBtn.disabled = true;
    testKeyBtn.innerHTML = '<span class="spinner"></span> Testing…';
    setKeyStatus('testing', 'Testing connection…');

    try {
      await window.electronAPI.saveSettings(built.payload);

      const g = await window.electronAPI.testGeminiConnection();
      if (!g || !g.success) {
        setKeyStatus('error', `Gemini: ${(g && g.error) || 'connection failed'}`);
        return;
      }
      let text = 'Gemini connected';
      if (built.hasOtherAi && window.electronAPI.gatewayTestApi) {
        const o = await window.electronAPI.gatewayTestApi({});
        text += o && o.success
          ? ' · other AI connected'
          : ` · other AI failed (${(o && o.error) || 'unknown'}), Gemini will answer instead`;
      }
      setKeyStatus('success', text);
    } catch (e) {
      setKeyStatus('error', e.message || 'Connection failed');
    } finally {
      testKeyBtn.disabled = false;
      testKeyBtn.innerHTML = originalHtml;
    }
  });

  // Close button: leave the wizard without finishing.
  $('#closeBtn').addEventListener('click', async () => {
    try {
      await window.electronAPI.dismissOnboarding();
    } catch (_) {
      window.close();
    }
  });

  // ── Wire up: Speech choices ───────────────────────────────────────
  $$('#speechChoices .choice-card').forEach((card) => {
    card.addEventListener('click', () => {
      const value = card.dataset.value;
      state.speechProvider = value;
      $$('#speechChoices .choice-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      const azurePanel = $('#azurePanel');
      azurePanel.style.display = value === 'azure' ? 'block' : 'none';
      $('#whisperPanel').style.display = value === 'whisper' ? 'block' : 'none';
      if (value !== 'azure') {
        state.azureKey = '';
        state.azureRegion = '';
      }
    });
  });

  // Local Whisper settings (shown while Whisper is selected)
  const whisperFields = {
    whisperModel: $('#whisperModel'),
    whisperLanguage: $('#whisperLanguage'),
    whisperDevice: $('#whisperDevice'),
    whisperCaptureMode: $('#whisperCaptureMode'),
    whisperSegmentMs: $('#whisperSegmentMs'),
  };
  Object.entries(whisperFields).forEach(([key, el]) => {
    ['input', 'change'].forEach((evt) => {
      el.addEventListener(evt, () => { state[key] = el.value.trim(); });
    });
  });

  $('#azureKey').addEventListener('input', (e) => { state.azureKey = e.target.value.trim(); });
  $('#azureRegion').addEventListener('input', (e) => { state.azureRegion = e.target.value.trim(); });

  // ── Wire up: Whisper screen ───────────────────────────────────────
  const installLog = $('#installLog');
  const detectCmd = $('#detectCmd');
  const detectStatus = $('#detectStatus');
  const installList = $('#installList');
  const installCardTitle = $('#installCardTitle');

  function appendLog(line) {
    installLog.textContent += (installLog.textContent ? '\n' : '') + line;
    installLog.scrollTop = installLog.scrollHeight;
  }

  function setDetectStatus(state_, text) {
    detectStatus.className = `status-pill ${state_}`;
    const icon = detectStatus.querySelector('i');
    if (state_ === 'success') icon.className = 'fas fa-check-circle';
    else if (state_ === 'error') icon.className = 'fas fa-circle-xmark';
    else if (state_ === 'idle') icon.className = 'fas fa-circle-info';
    else icon.className = 'fas fa-circle-notch fa-spin';
    detectStatus.querySelector('.text').textContent = text;
  }

  async function runWhisperDetect() {
    detectCmd.textContent = 'scanning…';
    setDetectStatus('testing', 'Probing');
    try {
      const r = await window.electronAPI.detectWhisper();
      if (r.found) {
        state.whisperDetected = true;
        state.whisperCmd = r.command;
        detectCmd.textContent = r.command;
        setDetectStatus('success', `Found v${r.version || '?'}`);
        appendLog(`✓ Detected Whisper CLI: ${r.command}`);
      } else {
        detectCmd.textContent = 'not found';
        setDetectStatus('error', 'Not installed');
        appendLog('✗ No Whisper CLI detected on PATH or in known venvs');
      }
    } catch (e) {
      setDetectStatus('error', 'Probe failed');
      appendLog(`! Detection error: ${e.message || e}`);
    }
  }

  async function runWhisperInstall() {
    const btn = document.getElementById('installWhisperBtn');
    installLog.textContent = '';
    setDetectStatus('testing', 'Installing');
    appendLog('Starting install…');

    // Lock the button while installing so the user can't double-click
    // and spawn parallel installs. Change the label to "Installing…"
    // with a spinner so they see real progress.
    if (btn) {
      btn.disabled = true;
      btn.dataset.originalHtml = btn.dataset.originalHtml || btn.innerHTML;
      btn.innerHTML = '<span class="spinner"></span> Installing…';
    }

    // Subscribe to streamed progress lines from the main process.
    // `installWhisper()` only returns once install completes; live
    // output comes through `onInstallProgress` events.
    let progressHandler = null;
    if (window.electronAPI && window.electronAPI.onInstallProgress) {
      progressHandler = (line) => appendLog(line);
      window.electronAPI.onInstallProgress(progressHandler);
    }

    try {
      const r = await window.electronAPI.installWhisper();
      if (r.ok) {
        state.whisperDetected = true;
        state.whisperCmd = r.command;
        detectCmd.textContent = r.command;
        setDetectStatus('success', 'Installed');
        appendLog(`\n✓ ${r.message}`);
        if (btn) {
          // Keep button disabled — install is done. Show a checkmark
          // so the user sees the final state at a glance.
          btn.innerHTML = '<i class="fas fa-check-circle"></i> Installed';
          btn.classList.remove('primary');
          btn.classList.add('success');
        }
      } else {
        setDetectStatus('error', 'Install failed');
        appendLog(`\n✗ ${r.message}`);
        // Restore the button so the user can retry.
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = btn.dataset.originalHtml || '<i class="fas fa-download"></i> Install Whisper now';
        }
      }
    } catch (e) {
      setDetectStatus('error', 'Install error');
      appendLog(`\n! ${e.message || e}`);
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = btn.dataset.originalHtml || '<i class="fas fa-download"></i> Install Whisper now';
      }
    } finally {
      if (progressHandler && window.electronAPI.removeAllListeners) {
        try { window.electronAPI.removeAllListeners('install-progress'); } catch (_) { /* ignore */ }
      }
    }
  }

  // Whisper screen logic
  let whisperInitialized = false;
  function enterWhisperScreen() {
    if (whisperInitialized) return;
    whisperInitialized = true;
    const hints = {
      win32: {
        title: "We'll create a project-local venv and install openai-whisper",
        steps: [
          'Python 3.10+ must be on PATH (download from python.org if missing).',
          'A new <code>.venv-whisper\\</code> folder will be created in the app directory.',
          'Whisper will be installed into that venv (pip download, no admin rights needed).',
          'First transcription downloads the <code>small</code> model (~461 MB).',
        ],
      },
      darwin: {
        title: "We'll create a project-local venv and install openai-whisper",
        steps: [
          'Uses your existing Python 3 (install via Homebrew if missing).',
          'A new <code>.venv-whisper/</code> folder is created in the app data directory.',
          'Whisper installs into that venv — no <code>sudo</code> required.',
          'First transcription downloads the <code>small</code> model (~461 MB).',
        ],
      },
      other: {
        title: "We'll create a project-local venv and install openai-whisper",
        steps: [
          'Uses your system Python 3 (needs <code>python3-venv</code> on Debian/Ubuntu).',
          'A new <code>.venv-whisper/</code> folder is created in the app data directory.',
          'Whisper installs into that venv — avoids the externally-managed-environment error.',
          'First transcription downloads the <code>small</code> model (~461 MB).',
        ],
      },
    };
    const plat = navigator.platform.toLowerCase().includes('win')
      ? 'win32'
      : navigator.platform.toLowerCase().includes('mac')
        ? 'darwin'
        : 'other';
    const h = hints[plat];
    installCardTitle.textContent = h.title;
    installList.innerHTML = h.steps.map((s) => `<li>${s}</li>`).join('');
    runWhisperDetect();
  }

  // ── Wire up: Model Download screen ───────────────────────────────
  const modelDownloadLog = $('#modelDownloadLog');
  const modelDownloadChoices = $('#modelDownloadChoices');

  function appendModelLog(line) {
    modelDownloadLog.textContent += (modelDownloadLog.textContent ? '\n' : '') + line;
    modelDownloadLog.scrollTop = modelDownloadLog.scrollHeight;
  }

  let modelDownloadInitialized = false;
  function enterModelDownloadScreen() {
    if (!modelDownloadInitialized) {
      modelDownloadInitialized = true;

      // Set up choice card click handlers once
      $$('#modelDownloadChoices .choice-card').forEach((card) => {
        card.addEventListener('click', () => {
          const value = card.dataset.value;
          state.modelDownloadChoice = value;
          $$('#modelDownloadChoices .choice-card').forEach((c) => c.classList.remove('selected'));
          card.classList.add('selected');
          
          if (value === 'now') {
            // Start downloading the model immediately
            startModelDownload();
          } else {
            nextBtn.disabled = false;
          }
        });
      });
    }

    // Restore selection state when navigating back
    $$('#modelDownloadChoices .choice-card').forEach((card) => {
      card.classList.toggle('selected', card.dataset.value === state.modelDownloadChoice);
    });

    // Re-enable continue button if a choice has been made and not actively downloading
    if (state.modelDownloadChoice && !state.modelDownloading) {
      nextBtn.disabled = false;
    }
  }

  async function startModelDownload() {
    state.modelDownloading = true;
    nextBtn.disabled = true;
    nextBtn.innerHTML = '<span class="spinner"></span> Downloading…';

    appendModelLog('Starting model download…');

    let progressHandler = null;
    if (window.electronAPI && window.electronAPI.onInstallProgress) {
      progressHandler = (line) => appendModelLog(line);
      window.electronAPI.onInstallProgress(progressHandler);
    }

    try {
      const r = await window.electronAPI.downloadWhisperModel(state.whisperModel || 'small');
      state.modelDownloading = false;
      if (r.ok) {
        state.modelDownloaded = true;
        appendModelLog(`\n✓ Model downloaded successfully: ${r.path}`);
        nextBtn.disabled = false;
        nextBtn.classList.remove('primary');
        nextBtn.classList.add('success');
        nextBtn.innerHTML = '<i class="fas fa-check-circle"></i> Continue';
      } else {
        appendModelLog(`\n✗ Download failed: ${r.message}`);
        // Let user continue anyway; they'll download on first use
        nextBtn.disabled = false;
      }
    } catch (e) {
      state.modelDownloading = false;
      appendModelLog(`\n! Error: ${e.message || e}`);
      nextBtn.disabled = false;
    } finally {
      if (progressHandler && window.electronAPI.removeAllListeners) {
        try { window.electronAPI.removeAllListeners('install-progress'); } catch (_) { /* ignore */ }
      }
    }
  }

  // ── Wire up: OCR screen ───────────────────────────────────────────
  const ocrLog = $('#ocrLog');
  function appendOcrLog(line) {
    ocrLog.textContent += (ocrLog.textContent ? '\n' : '') + line;
    ocrLog.scrollTop = ocrLog.scrollHeight;
  }

  async function startOcrDownload() {
    state.ocrDownloading = true;
    nextBtn.disabled = true;
    nextBtn.innerHTML = '<span class="spinner"></span> Downloading…';
    appendOcrLog('Starting download…');
    const stop = window.electronAPI.onInstallProgress ? window.electronAPI.onInstallProgress(appendOcrLog) : null;
    try {
      const r = await window.electronAPI.installOcr();
      if (r && r.ok) {
        state.ocrInstalled = true;
        appendOcrLog('\n✓ OCR data installed.');
      } else {
        appendOcrLog(`\n✗ Download failed: ${(r && r.message) || 'unknown error'}. It will be retried on first use.`);
      }
    } catch (e) {
      appendOcrLog(`\n✗ Download failed: ${e.message}. It will be retried on first use.`);
    } finally {
      if (typeof stop === 'function') stop();
      state.ocrDownloading = false;
      nextBtn.disabled = false;
      nextBtn.innerHTML = 'Continue <i class="fas fa-arrow-right"></i>';
    }
  }

  let ocrInitialized = false;
  async function enterOcrScreen() {
    if (!ocrInitialized) {
      ocrInitialized = true;
      $$('#ocrChoices .choice-card').forEach((card) => {
        card.addEventListener('click', () => {
          if (state.ocrDownloading) return;
          state.ocrChoice = card.dataset.value;
          $$('#ocrChoices .choice-card').forEach((c) => c.classList.toggle('selected', c === card));
          if (state.ocrChoice === 'now' && !state.ocrInstalled) startOcrDownload();
          else nextBtn.disabled = false;
        });
      });
      try {
        const s = await window.electronAPI.getOcrStatus();
        if (s && s.installed) {
          state.ocrInstalled = true;
          state.ocrChoice = state.ocrChoice || 'now';
          $('#ocrTitle').textContent = 'OCR data is already installed';
          $$('#ocrChoices .choice-card').forEach((c) => c.classList.toggle('selected', c.dataset.value === 'now'));
          appendOcrLog('✓ OCR data already installed.');
        }
      } catch (_) { /* status is optional */ }
    }
    nextBtn.disabled = !(state.ocrChoice || state.ocrInstalled) || state.ocrDownloading;
  }

  // ── Wire up: Finish screen ────────────────────────────────────────
  function populateSummary() {
    const rows = [];
    rows.push({
      label: '<i class="fas fa-key"></i> Gemini API',
      value: llmKeyReady() ? 'Configured' : 'Missing',
      cls: llmKeyReady() ? 'ok' : 'skip',
    });
    if (state.speechProvider === 'whisper') {
      rows.push({
        label: '<i class="fas fa-microphone"></i> Speech',
        value: state.whisperDetected ? `Whisper (${state.whisperCmd || 'cli'})` : 'Whisper (not installed)',
        cls: state.whisperDetected ? 'ok' : 'skip',
      });
    } else if (state.speechProvider === 'azure') {
      rows.push({
        label: '<i class="fas fa-cloud"></i> Speech',
        value: 'Azure',
        cls: 'ok',
      });
    } else {
      rows.push({
        label: '<i class="fas fa-microphone"></i> Speech',
        value: 'Skipped (configure later)',
        cls: 'skip',
      });
    }
    rows.push({
      label: '<i class="fas fa-sliders"></i> Mode',
      value: state.activeSkill === 'dsa'
        ? `DSA, ${({ cpp: 'C++', c: 'C', python: 'Python', java: 'Java', javascript: 'JavaScript' })[state.codingLanguage] || state.codingLanguage}`
        : 'Interview',
      cls: 'ok',
    });
    rows.push({
      label: '<i class="fas fa-desktop"></i> Read screen on questions',
      value: state.autoScreen ? 'On' : 'Off (Ctrl+Shift+S only)',
      cls: state.autoScreen ? 'ok' : 'skip',
    });
    rows.push({
      label: '<i class="fas fa-eye"></i> Screen reading (OCR)',
      value: state.ocrInstalled ? 'Ready' : 'Downloads on first use',
      cls: state.ocrInstalled ? 'ok' : 'skip',
    });
    rows.push({
      label: '<i class="fas fa-file-lines"></i> Config saved to',
      value: '.env',
      cls: 'ok',
    });
    $('#summaryList').innerHTML = rows
      .map((r) => `
        <div class="summary-row">
          <div class="label">${r.label}</div>
          <div class="value ${r.cls}">${r.value}</div>
        </div>
      `)
      .join('');
  }

  // ── Wire up: Hero CTA (welcome screen) ────────────────────────────
  // The big inline "Get Started" button on the welcome screen reuses
  // the existing nav-button handler so all validation, persistence,
  // and navigation logic stays in one place.
  const heroCtaBtn = $('#heroCtaBtn');
  if (heroCtaBtn) {
    heroCtaBtn.addEventListener('click', () => nextBtn.click());
  }

  // ── Wire up: Preferences ──────────────────────────────────────────
  const prefSkill = $('#prefSkill');
  const prefLanguage = $('#prefLanguage');
  prefSkill.addEventListener('change', () => {
    state.activeSkill = prefSkill.value;
    prefLanguage.disabled = state.activeSkill !== 'dsa';
  });
  prefLanguage.addEventListener('change', () => { state.codingLanguage = prefLanguage.value; });
  $$('#prefAutoScreen .choice-card').forEach((card) => {
    card.addEventListener('click', () => {
      state.autoScreen = card.dataset.value === 'true';
      $$('#prefAutoScreen .choice-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
    });
  });

  // ── Wire up: nav buttons ──────────────────────────────────────────
  nextBtn.addEventListener('click', async () => {
    const name = currentScreenName();
    if (!canAdvance()) {
      // Lightly nudge the user
      if (name === 'apikey') setKeyStatus('error', 'Enter a Gemini API key');
      return;
    }

    // Persist settings on speech selection (Azure path), since we
    // already saved geminiKey on test; do it here too if user skipped
    // testing.
    if (name === 'apikey' && window.electronAPI) {
      try {
        const built = buildLlmPayload();
        if (built.error) { setKeyStatus('error', built.error); return; }
        await window.electronAPI.saveSettings(built.payload);
      } catch (_) { /* surfaced elsewhere */ }
    }
    if (name === 'preferences' && window.electronAPI) {
      try {
        await window.electronAPI.saveSettings({
          activeSkill: state.activeSkill,
          codingLanguage: state.codingLanguage,
          autoScreen: state.autoScreen,
        });
      } catch (_) { /* surfaced elsewhere */ }
    }
    if (name === 'speech' && window.electronAPI) {
      try {
        const payload = {
          speechProvider:
            state.speechProvider === 'skip' ? 'whisper' : state.speechProvider,
        };
        if (state.speechProvider === 'azure') {
          payload.azureKey = state.azureKey;
          payload.azureRegion = state.azureRegion;
        }
        if (state.speechProvider === 'whisper') {
          payload.whisperModel = state.whisperModel || 'small';
          payload.whisperLanguage = state.whisperLanguage || 'auto';
          payload.whisperDevice = state.whisperDevice;
          payload.whisperCaptureMode = state.whisperCaptureMode;
          payload.whisperSegmentMs = state.whisperSegmentMs || '4000';
          if (state.whisperCmd) payload.whisperCommand = quoteCommandIfNeeded(state.whisperCmd);
        }
        await window.electronAPI.saveSettings(payload);
      } catch (_) { /* surfaced elsewhere */ }
    }

    // Whisper screen: kick off detection on entry
    if (name === 'speech' && state.speechProvider === 'whisper') {
      // (deferred: will run via enterWhisperScreen)
    }

    // Whisper screen "Continue" — if user wants to skip install, mark and proceed
    if (name === 'whisper') {
      // Persist whatever whisper command we found (could be empty if skipped)
      if (window.electronAPI && state.whisperCmd) {
        try {
          await window.electronAPI.saveSettings({ whisperCommand: quoteCommandIfNeeded(state.whisperCmd) });
        } catch (_) { /* ignore */ }
      }
    }

    // Model download screen: persist choice
    if (name === 'model-download') {
      if (window.electronAPI && state.modelDownloadChoice) {
        try {
          await window.electronAPI.saveSettings({ whisperModelDownload: state.modelDownloadChoice });
        } catch (_) { /* ignore */ }
      }
    }

    // Finish: close onboarding
    if (name === 'finish') {
      try {
        await window.electronAPI.completeFirstRun();
      } catch (_) { /* ignore */ }
      try {
        await window.electronAPI.closeOnboarding();
      } catch (_) { /* ignore */ }
      state.finished = true;
      return;
    }

    // Move forward, with whisper-screen insertion handled by order logic
    const order = computeScreenOrder();
    const idx = order.indexOf(name);
    const nextName = order[idx + 1];
    if (!nextName) return;

    // Compute new step index
    state.step = orderScreenToStep(nextName);
    showScreen(nextName);
    if (nextName === 'ocr') enterOcrScreen();
    if (nextName === 'whisper') enterWhisperScreen();
    if (nextName === 'model-download') enterModelDownloadScreen();
    if (nextName === 'finish') populateSummary();

    // Re-render stepper with new total
    refreshStepper();
  });

  backBtn.addEventListener('click', () => {
    const name = currentScreenName();
    const order = computeScreenOrder();
    const idx = order.indexOf(name);
    const prevName = order[idx - 1];
    if (!prevName) return;
    state.step = orderScreenToStep(prevName);
    showScreen(prevName);
  });

  // Skip button: only shown on the whisper screen, lets user skip install
  // even if the CLI isn't present (they can configure later).
  function refreshSkipVisibility() {
    skipBtn.style.display = currentScreenName() === 'whisper' && !state.whisperDetected
      ? 'inline-flex'
      : 'none';
  }

  // Hook into showScreen to keep skip visibility in sync
  const _origShowScreen = showScreen;
  showScreen = function (name) {
    _origShowScreen(name);
    refreshSkipVisibility();
    refreshStepper();
  };

  skipBtn.addEventListener('click', () => {
    state.skippingWhisper = true;
    // Jump to finish without installing
    const order = computeScreenOrder();
    const finishName = order[order.length - 1];
    state.step = orderScreenToStep(finishName);
    showScreen(finishName);
    populateSummary();
  });

  // ── Manual install button (added dynamically) ─────────────────────
  function addManualInstallButton() {
    if (document.getElementById('installWhisperBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'installWhisperBtn';
    btn.type = 'button';
    btn.className = 'btn primary';
    btn.style.marginTop = '12px';
    btn.innerHTML = '<i class="fas fa-download"></i> Install Whisper now';
    btn.addEventListener('click', runWhisperInstall);
    document.querySelector('[data-screen="whisper"]').appendChild(btn);
  }

  // Show install button after detection runs and finds nothing
  const _origDetect = runWhisperDetect;
  runWhisperDetect = async function () {
    await _origDetect();
    if (!state.whisperDetected) addManualInstallButton();
  };

  // ── Boot ──────────────────────────────────────────────────────────
  showScreen('welcome');

  // Pre-populate Gemini key from existing .env (if any) so users with
  // a partial config don't have to retype.
  if (window.electronAPI && window.electronAPI.getFirstRunStatus) {
    window.electronAPI.getFirstRunStatus().then((s) => {
      if (!s) return;
      // We can't read the keys back, but we can mark them as set if the env
      // file already has one and let the user advance without retyping.
      if (s.geminiConfigured) {
        state.geminiConfigured = true;
        geminiInput.placeholder = '•••••••••••••••• (already set)';
      }
      if (s.anthropicConfigured) {
        state.gatewayConfigured = true;
        gatewayInput.placeholder = '•••••••••••••••• (already set)';
      }
      refreshKeyStatus();
    }).catch(() => {});
  }

  // Prefill the Whisper settings with whatever is currently configured
  // (falls back to the built-in defaults already in the form).
  if (window.electronAPI && window.electronAPI.getSettings) {
    window.electronAPI.getSettings().then((cfg) => {
      if (!cfg) return;
      if (cfg.activeSkill) { state.activeSkill = cfg.activeSkill; prefSkill.value = cfg.activeSkill; }
      if (cfg.codingLanguage) { state.codingLanguage = cfg.codingLanguage; prefLanguage.value = cfg.codingLanguage; }
      prefLanguage.disabled = state.activeSkill !== 'dsa';
      if (typeof cfg.autoScreen === 'boolean') {
        state.autoScreen = cfg.autoScreen;
        $$('#prefAutoScreen .choice-card').forEach((c) => c.classList.toggle('selected', (c.dataset.value === 'true') === cfg.autoScreen));
      }
      const map = {
        whisperModel: cfg.whisperModel,
        whisperLanguage: cfg.whisperLanguage,
        whisperDevice: cfg.whisperDevice,
        whisperCaptureMode: cfg.whisperCaptureMode,
        whisperSegmentMs: cfg.whisperSegmentMs,
      };
      Object.entries(map).forEach(([key, value]) => {
        if (value === undefined || value === null || value === '') return;
        state[key] = String(value);
        whisperFields[key].value = String(value);
      });
    }).catch(() => {});
  }
})();
