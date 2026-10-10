// Fills in the application name from APP_NAME (.env) so the UI never hard-codes it.
// Mark an element with data-app-name (optionally a template like "Welcome to {name}")
// or data-app-name-title to set its tooltip.
(function () {
  const api = window.electronAPI;
  if (!api || typeof api.getAppName !== 'function') return;

  let appName = null;

  function apply() {
    const name = appName;
    if (!name) return;
    document.querySelectorAll('[data-app-name]').forEach((el) => {
      const tpl = el.getAttribute('data-app-name');
      el.textContent = tpl ? tpl.replace('{name}', name) : name;
    });
    document.querySelectorAll('[data-app-name-title]').forEach((el) => {
      el.title = el.getAttribute('data-app-name-title').replace('{name}', name);
    });
    document.title = document.title.replace(/\bCode\b/, name);
  }

  // Dynamically rendered text can call this after it is inserted.
  window.applyAppName = apply;
  api.getAppName().then((name) => { appName = name; apply(); }).catch(() => {});
})();
