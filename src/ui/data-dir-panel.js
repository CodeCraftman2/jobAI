/* Data folder picker shared by onboarding and Settings.
 *
 *   const panel = DataDirPanel.mount({ input, browseBtn, testBtn, statusEl, resultsEl, currentEl });
 *   await panel.apply({ resume: 'apikey' })   // test, copy, point the app there, restart
 *
 * The main process does the work (main.js "data-dir-*" handlers,
 * src/core/data-location.js); this file only wires the controls.
 */
(function () {
  'use strict';

  const ICON = { ok: 'fa-circle-check', warn: 'fa-triangle-exclamation', error: 'fa-circle-xmark' };

  function injectStyles() {
    if (document.getElementById('dd-styles')) return;
    const s = document.createElement('style');
    s.id = 'dd-styles';
    s.textContent = `
      .dd-results { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; font-size: 12.5px; line-height: 1.45; }
      .dd-results:empty { display: none; }
      .dd-check { display: grid; grid-template-columns: 16px auto 1fr; gap: 8px; align-items: baseline; }
      .dd-check .dd-name { font-weight: 600; white-space: nowrap; }
      .dd-check .dd-detail { opacity: 0.85; overflow-wrap: anywhere; }
      .dd-check.ok i { color: #4ade80; }
      .dd-check.warn i { color: #fbbf24; }
      .dd-check.error i { color: #f87171; }
      .dd-status { font-size: 12px; overflow-wrap: anywhere; }
      .dd-status[data-kind="ok"] { color: #4ade80; }
      .dd-status[data-kind="warn"] { color: #fbbf24; }
      .dd-status[data-kind="error"] { color: #f87171; }
      .dd-status[data-kind="testing"] { opacity: 0.8; }
      .dd-current { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
    `;
    document.head.appendChild(s);
  }

  function mount(opts) {
    injectStyles();
    const api = window.electronAPI || {};
    const { input, browseBtn, testBtn, statusEl, resultsEl, currentEl } = opts;
    let info = null;
    let lastTest = null; // { dir, result }
    let busy = false;

    const setStatus = (text, kind) => {
      if (!statusEl) return;
      statusEl.textContent = text || '';
      statusEl.dataset.kind = kind || '';
      if (opts.onStatus) opts.onStatus(text, kind);
    };

    const renderChecks = (checks) => {
      if (!resultsEl) return;
      resultsEl.textContent = '';
      (checks || []).forEach((c) => {
        const row = document.createElement('div');
        row.className = `dd-check ${c.level}`;
        const i = document.createElement('i');
        i.className = `fas ${ICON[c.level] || ICON.ok}`;
        const name = document.createElement('span');
        name.className = 'dd-name';
        name.textContent = c.name;
        const detail = document.createElement('span');
        detail.className = 'dd-detail';
        detail.textContent = c.detail;
        row.append(i, name, detail);
        resultsEl.appendChild(row);
      });
    };

    const setBusy = (on) => {
      busy = on;
      [browseBtn, testBtn, input].forEach((el) => { if (el) el.disabled = on || !!(info && info.envOverride); });
      // The page owns its apply/continue button; tell it to re-check.
      if (opts.onChange) opts.onChange();
    };

    const value = () => (input ? input.value.trim() : '');
    const same = (a, b) => String(a || '').replace(/[\\/]+$/, '').toLowerCase() === String(b || '').replace(/[\\/]+$/, '').toLowerCase();

    const ready = (async () => {
      if (!api.getDataDirInfo) return;
      info = await api.getDataDirInfo();
      if (input && !input.value) input.value = info.dir;
      if (currentEl) currentEl.textContent = info.dir;
      if (info.envOverride) {
        setBusy(false);
        setStatus('Set by JOBAI_DATA_DIR. Remove that variable to choose a folder here.', 'warn');
      } else if (info.unreachable) {
        setStatus(`Your chosen folder (${info.unreachable.dir}) could not be opened, so Termax is using ${info.dir}. Reconnect the drive and restart Termax, or choose again.`, 'error');
        if (input && info.unreachable.dir) input.value = info.unreachable.dir;
      }
    })().catch((e) => setStatus(`Could not read the data folder: ${e.message}`, 'error'));

    async function test() {
      const dir = value();
      setBusy(true);
      setStatus('Testing…', 'testing');
      renderChecks([]);
      try {
        const r = await api.testDataDir(dir);
        lastTest = { dir, result: r };
        renderChecks(r.checks);
        const warns = r.checks.filter((c) => c.level === 'warn').length;
        if (!r.ok) setStatus('This folder will not work. See below.', 'error');
        else setStatus(warns ? 'Usable, with a warning. See below.' : 'Folder test passed.', warns ? 'warn' : 'ok');
        return r;
      } catch (e) {
        setStatus(`Test failed: ${e.message}`, 'error');
        return { ok: false, checks: [] };
      } finally {
        setBusy(false);
      }
    }

    function isChanged() {
      return !!info && !info.envOverride && !!value() && !same(value(), info.dir);
    }

    /** Test (unless just tested), then copy and restart. Resolves { changed, ok }. */
    async function apply(applyOpts = {}) {
      await ready;
      if (!isChanged()) return { ok: true, changed: false };
      const r = lastTest && lastTest.dir === value() ? lastTest.result : await test();
      if (!r.ok) return { ok: false, changed: false };
      setBusy(true);
      setStatus('Copying your data…', 'testing');
      const stop = api.onDataDirProgress ? api.onDataDirProgress((line) => setStatus(line, 'testing')) : null;
      try {
        const res = await api.applyDataDir(value(), applyOpts);
        if (!res || !res.success) {
          if (res && res.test) renderChecks(res.test.checks);
          setStatus((res && res.error) || 'Could not switch folders.', 'error');
          setBusy(false);
          return { ok: false, changed: false };
        }
        if (res.failed && res.failed.length) {
          renderChecks([{ name: 'Copy', level: 'warn', detail: `${res.failed.length} file(s) could not be copied (in use). They stay in the old folder.` }]);
        }
        // The app restarts in a moment; keep the controls locked.
        return { ok: true, changed: !!res.changed };
      } finally {
        if (stop) stop();
      }
    }

    if (browseBtn) browseBtn.addEventListener('click', async () => {
      if (busy || !api.browseDataDir) return;
      const picked = await api.browseDataDir(value());
      if (picked && input) {
        input.value = picked;
        lastTest = null;
        renderChecks([]);
        setStatus('', '');
        if (opts.onChange) opts.onChange();
      }
    });
    if (testBtn) testBtn.addEventListener('click', () => { if (!busy) test(); });
    if (input) input.addEventListener('input', () => {
      lastTest = null;
      renderChecks([]);
      setStatus('', '');
      if (opts.onChange) opts.onChange();
    });

    return { ready, test, apply, isChanged, isBusy: () => busy, info: () => info, value };
  }

  window.DataDirPanel = { mount };
})();
