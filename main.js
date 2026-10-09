const path = require("path");
const fs = require("fs");
const { fileURLToPath } = require("url");
const { app, BrowserWindow, globalShortcut, session, ipcMain, desktopCapturer, safeStorage } = require("electron");

// ── Resolve a stable .env location ──
// In packaged builds process.cwd() is unstable and frequently read-only
// (NSIS install dir, AppImage mount, .app bundle), so the canonical config
// lives in Electron's userData directory. We still prefer an existing
// project-local .env in development (npm start) so the dev workflow is
// unchanged. Both onboarding (FirstRunManager) and persistEnvUpdates() write
// to this same path so settings survive restarts on every platform.
function resolveEnvPath() {
  try {
    const userDataEnv = path.join(app.getPath("userData"), ".env");
    const projectEnv = path.join(process.cwd(), ".env");
    // Prefer a project .env only when it already exists and userData has none
    // (i.e. a developer running from the repo). Otherwise use userData. An
    // installed app never touches a .env that merely sits in its working directory.
    if (!app.isPackaged && !fs.existsSync(userDataEnv) && fs.existsSync(projectEnv)) {
      return projectEnv;
    }
    return userDataEnv;
  } catch (_) {
    // On packaged macOS builds, process.cwd() may be inside a read-only .app
    // bundle. Fall back to userData so .env writes never fail.
    try {
      return path.join(app.getPath("userData"), ".env");
    } catch (e2) {
      return path.join(process.cwd(), ".env");
    }
  }
}
const ENV_PATH = resolveEnvPath();
require("dotenv").config({ path: ENV_PATH });

// Settings used to be Anthropic-only (ANTHROPIC_*). Carry old values over to
// the provider-neutral GATEWAY_* names so existing .env files keep working.
for (const suffix of ["API_KEY", "MODELS", "EFFORT", "DISCOVERY", "BASE_URL", "AUTH"]) {
  const legacy = process.env[`ANTHROPIC_${suffix}`];
  if (legacy && !process.env[`GATEWAY_${suffix}`]) process.env[`GATEWAY_${suffix}`] = legacy;
}
if (process.env.ANTHROPIC_MODEL && !process.env.GATEWAY_MODELS) process.env.GATEWAY_MODELS = process.env.ANTHROPIC_MODEL;
if ((process.env.LLM_PROVIDER || "").toLowerCase() === "anthropic") process.env.LLM_PROVIDER = "gateway";

// Format a value for a single .env line. Newlines are collapsed to spaces and
// backslashes are kept verbatim (doubling them corrupts Windows paths on the
// next load). Values containing whitespace, a double-quote, or a leading '#'
// are wrapped in single quotes so dotenv parses them as one token — essential
// for Whisper commands like:  "C:\Users\Jane Doe\...\python.exe" -m whisper
function formatEnvValue(raw) {
  const v = String(raw).replace(/[\r\n]+/g, " ").trim();
  if (!/[\s"#]/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  // Rare: value already contains a single quote — fall back to double quotes.
  return `"${v.replace(/"/g, '\\"')}"`;
}

// ── Linux GPU process crash workaround ──
// On many Linux setups (Wayland, X11 without GPU drivers, Docker, headless,
// or systems with broken Mesa/NVIDIA stacks), Chromium's GPU process crashes
// on startup with:
//   FATAL:gpu_data_manager_impl_private.cc(448)] GPU process isn't usable.
// This kills the entire app and can leave orphan helper processes that
// exhaust the X11 client limit, producing "Maximum number of clients reached".
//
// Disabling hardware acceleration and the GPU subprocess forces Chromium to
// render via the CPU (SwiftShader). JobAI's UI is light enough that
// this is imperceptible, and it eliminates the GPU crash entirely.
if (process.platform === "linux") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  // On X11 only; harmless on Wayland. Prevents Chromium from spawning a
  // compositor process that adds another X11 client.
  app.commandLine.appendSwitch("in-process-gpu");
}

// Keep Chromium network noise out of the terminal; app-level logs still go through Winston.
app.commandLine.appendSwitch("log-level", "3");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("no-pings");

const logger = require("./src/core/logger").createServiceLogger("MAIN");
const config = require("./src/core/config");
const FirstRunManager = require("./src/core/first-run");
const secureStore = require("./src/core/secure-store");

// ── Global crash guard ──
// The speech path spawns external processes (Whisper CLI, and on macOS/Linux
// the sox/rec/arecord recorders via node-record-lpcm16). A missing recorder
// binary makes that library emit an 'error' on its child process with no
// listener, which would otherwise become an uncaughtException and quit the
// entire app the moment the user clicks the mic. We log and stay alive — the
// speech service surfaces a friendly status to the UI instead.
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception (kept alive)", {
    error: err && err.message,
    stack: err && err.stack,
  });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection (kept alive)", {
    reason: String((reason && reason.message) || reason),
  });
});

// Services
// Screen capture (image-based)
const captureService = require("./src/services/capture.service");
const speechService = require("./src/services/speech.service");
const llmService = require("./src/services/llm.service");
const ocrService = require("./src/services/ocr.service");

// Managers
const windowManager = require("./src/managers/window.manager");
const sessionManager = require("./src/managers/session.manager");

const CODING_LANGUAGES = ["cpp", "c", "python", "java", "javascript"];

class ApplicationController {
  constructor() {
    this.isReady = false;
    this.starting = false;
    // Saved choices from Settings or the setup wizard; C++ and DSA when none.
    const savedLanguage = String(process.env.JOBAI_CODING_LANGUAGE || "").trim().toLowerCase();
    const savedSkill = String(process.env.JOBAI_ACTIVE_SKILL || "").trim().toLowerCase();
    this.activeSkill = savedSkill === "interview" ? "interview" : "dsa";
  this.codingLanguage = CODING_LANGUAGES.includes(savedLanguage) ? savedLanguage : "cpp";
    this.syncPreferredLanguage();
    this.speechAvailable = false;

    // Utterance coalescing: VAD emits a transcript per natural pause, but a
    // single spoken question can still arrive as a few fragments (mid-thought
    // pauses). We buffer fragments and debounce so one question yields one LLM
    // call instead of several slow, half-answered ones.
    this._utteranceBuffer = "";
    this._utteranceTimer = null;
    this._utteranceDispatchInFlight = false;
    this._utteranceCoalesceMs = 800;

    // First-run onboarding: detects missing .env / API key and triggers
    // a settings-window prompt on first launch so users don't have to
    // dig through docs to figure out they need a Gemini API key.
    this.firstRunManager = new FirstRunManager({
      logger: logger,
      // .env and the sentinel both live in userData so they survive cwd
      // changes and read-only install dirs (the app may be launched from
      // any directory). ENV_PATH is the same file dotenv loaded at startup
      // and that persistEnvUpdates() writes to.
      envPath: ENV_PATH,
      sentinelPath: path.join(app.getPath("userData"), ".jobai-firstrun-completed"),
      // API keys live in the OS keychain, so setup status also looks there.
      secrets: secureStore,
    });
    // Lazily-initialised in getWhisperInstaller() so tests can mock
    // the constructor without polluting main-process startup.
    this._whisperInstaller = null;
    this.isFirstRun = false;

    // Window configurations for reference
    this.windowConfigs = {
      main: { title: "Code" },
      settings: { title: "Settings" },
    };

    this.setupStealth();
    this.setupEventHandlers();
  }

  setupStealth() {
    if (config.get("stealth.disguiseProcess")) {
      process.title = config.get("app.processTitle");
    }

    // Set default stealth app name early
    if (app && typeof app.setName === 'function') {
      app.setName("Terminal ");
    }
    process.title = "Terminal ";

    if (
      process.platform === "darwin" &&
      config.get("stealth.noAttachConsole")
    ) {
      process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
      process.env.ELECTRON_NO_ASAR = "1";
    }
  }

  setupEventHandlers() {
    app.whenReady().then(() => this.onAppReady());
    app.on("window-all-closed", () => this.onWindowAllClosed());
    app.on("activate", () => this.onActivate());
    app.on("will-quit", () => this.onWillQuit());

    this.setupIPCHandlers();
    this.setupServiceEventHandlers();
  }

  handleSecondInstance() {
    logger.info("Second instance launch detected; focusing existing windows");

    const focusExistingWindows = () => {
      try {
        const mainWindow = windowManager.getWindow("main");
        if (mainWindow) {
          if (mainWindow.isMinimized && mainWindow.isMinimized()) {
            mainWindow.restore();
          }
          windowManager.showAllWindows();
          windowManager.showOnCurrentDesktop(mainWindow);
          mainWindow.focus();
          return;
        }

        if (this.isReady) {
          windowManager.showAllWindows();
        }
      } catch (error) {
        logger.error("Failed to focus existing instance", {
          error: error.message,
        });
      }
    };

    if (app.isReady()) {
      focusExistingWindows();
    } else {
      app.whenReady().then(focusExistingWindows);
    }
  }

  /**
   * Keys are kept in the OS keychain (see src/core/secure-store.js). Load them
   * into process.env, and move any key still sitting in plain text in .env
   * into the keychain, leaving that .env line empty.
   */
  setupSecureKeys() {
    try {
      if (!secureStore.init(app.getPath("userData"), safeStorage)) {
        logger.warn("OS keychain unavailable; API keys stay in .env");
        return;
      }
      const isReal = (v) => !!(v || "").trim() && !/^your[-_]/i.test(v.trim());
      const moved = [];
      for (const key of secureStore.SECRET_KEYS) {
        const inEnv = process.env[key];
        if (isReal(inEnv) && !secureStore.has(key)) {
          this.persistEnvUpdates({ [key]: inEnv });
          moved.push(key);
        }
      }
      const loaded = secureStore.loadIntoEnv();
      llmService.initializeClient();
      logger.info("API keys loaded from the OS keychain", { loaded, movedFromEnv: moved });
    } catch (e) {
      logger.warn("Could not set up the keychain", { error: e.message });
    }
  }

  async onAppReady() {
    if (this.starting || this.isReady) {
      logger.debug("onAppReady skipped: already starting or ready");
      return;
    }
    this.starting = true;

    // Force stealth mode IMMEDIATELY when app is ready
    app.setName("Terminal ");
    process.title = "Terminal ";

    logger.info("Application starting", {
      version: config.get("app.version"),
      environment: config.get("app.isDevelopment")
        ? "development"
        : "production",
      platform: process.platform,
    });

    try {
      this.setupSecureKeys();
      this.setupPermissions();
      this.setupNetworkConfiguration();

      // Small delay to ensure desktop/space detection is accurate
      await new Promise((resolve) => setTimeout(resolve, 200));

      // First-run onboarding: ensure .env exists and read status once
      // so we can decide whether to defer showing the main overlay.
      let status;
      try {
        this.firstRunManager.ensureEnv();
        status = this.firstRunManager.getStatus();
        this.isFirstRun = status.needsOnboarding;
        logger.info("First-run status", status);
      } catch (e) {
        logger.warn("First-run check failed", { error: e.message });
        status = { needsOnboarding: false };
        this.isFirstRun = false;
      }
      const isFirstRun = status.needsOnboarding;

      await windowManager.initializeWindows({ showMainWindow: !isFirstRun });
      this.setupGlobalShortcuts();

      // Initialize default stealth mode with terminal icon
      this.updateAppIcon("terminal");

      this.starting = false;
      this.isReady = true;

      // Launch the onboarding wizard if this is the first run.
      if (this.isFirstRun) {
        // Defer slightly so all windows finish loading before we pop
        // the wizard on top of them.
        setTimeout(() => {
          try {
            windowManager.showOnboarding();
            windowManager.broadcastToAllWindows("first-run", status);
            logger.info("First-run onboarding: wizard opened");
          } catch (e) {
            logger.warn("Could not open first-run onboarding window", {
              error: e.message
            });
            // Fallback to legacy settings prompt
            try { this.showSettings(); } catch (_) { /* ignore */ }
          }
        }, 800);
      } else {
        // Already configured — mark completed so we never nag again.
        this.firstRunManager.markCompleted();
      }

      logger.info("Application initialized successfully", {
        windowCount: Object.keys(windowManager.getWindowStats().windows).length,
        currentDesktop: "detected",
      });

      sessionManager.addEvent("Application started");
    } catch (error) {
      this.starting = false;
      logger.error("Application initialization failed", {
        error: error.message,
      });
      app.quit();
    }
  }

  setupNetworkConfiguration() {
    // Configure session to handle network requests better
    const ses = session.defaultSession;

    // Allow HTTPS requests to Google APIs
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      if (details.url.includes('generativelanguage.googleapis.com')) {
        const platformUA = process.platform === 'darwin'
          ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.156 Safari/537.36'
          : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.156 Safari/537.36';
        details.requestHeaders['User-Agent'] = platformUA;
      }
      callback({ requestHeaders: details.requestHeaders });
    });

    // Handle certificate errors for Google APIs
    ses.setCertificateVerifyProc((request, callback) => {
      if (request.hostname === 'generativelanguage.googleapis.com') {
        callback(0); // Trust Google's certificates
      } else {
        callback(-2); // Use default verification
      }
    });

    logger.debug('Network configuration applied for Gemini API');
  }

  setupPermissions() {
    const appSession = session.defaultSession;
    const isTrustedAppUrl = (url) => {
      try {
        const pagePath = path.resolve(fileURLToPath(url));
        const appRoot = path.resolve(__dirname);
        const normalizeForComparison = (value) => process.platform === "win32"
          ? value.toLowerCase()
          : value;
        const page = normalizeForComparison(pagePath);
        const root = normalizeForComparison(appRoot + path.sep);
        return page.startsWith(root);
      } catch (_) {
        return false;
      }
    };
    const isTrustedAppContents = (webContents) => {
      if (!webContents || webContents.isDestroyed()) {
        return false;
      }
      return isTrustedAppUrl(webContents.getURL());
    };

    // Speech input is system audio only: the app records what comes out of the
    // speakers (the other side of a meeting) and never the user's microphone.
    // "loopback" is Electron's Windows system-audio capture; a video source is
    // still required by the API, so the renderer drops the video track.
    appSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        if (!request.frame || !isTrustedAppUrl(request.frame.url)) {
          callback({});
          return;
        }
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 1, height: 1 }
        });
        if (!sources.length) {
          callback({});
          return;
        }
        callback({ video: sources[0], audio: "loopback" });
      } catch (error) {
        logger.error("System audio capture request failed", { error: error.message });
        callback({});
      }
    });

    // Electron exposes camera/microphone access as the single `media`
    // permission. The requested device type is provided separately in details.
    appSession.setPermissionCheckHandler(
      (webContents, permission, _requestingOrigin, details = {}) => {
        if (!isTrustedAppContents(webContents)) {
          return false;
        }
        if (permission === "media") {
          return !details.mediaType || details.mediaType === "audio";
        }
        return permission === "display-capture";
      }
    );

    appSession.setPermissionRequestHandler(
      (webContents, permission, callback, details = {}) => {
        let granted = false;
        if (isTrustedAppContents(webContents)) {
          if (permission === "media") {
            const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
            granted = mediaTypes.length === 0 || mediaTypes.includes("audio");
          } else {
            granted = permission === "display-capture";
          }
        }

        logger.debug("Permission request", {
          permission,
          mediaTypes: details.mediaTypes || [],
          granted
        });
        callback(granted);
      }
    );
  }

  setupGlobalShortcuts() {
    const shortcuts = {
      // Same keys as Pluely
      "CommandOrControl+Shift+S": () => this.triggerScreenshotOCR(), // Screenshot
      "CommandOrControl+\\": () => windowManager.toggleVisibility(), // Toggle window
      "CommandOrControl+Shift+I": () => this.focusPanelInput(), // Refocus input box
      "CommandOrControl+Shift+M": () => this.toggleSpeechRecognition(), // System audio
      "CommandOrControl+Shift+X": () => this.stopAutoMode("shortcut"), // Stop auto mode
      "CommandOrControl+Shift+D": () => this.toggleSettingsWindow(), // Dashboard (settings)
      "CommandOrControl+Up": () => this.moveMainWindow(0, -12), // Move window
      "CommandOrControl+Down": () => this.moveMainWindow(0, 12),
      "CommandOrControl+Left": () => this.moveMainWindow(-12, 0),
      "CommandOrControl+Right": () => this.moveMainWindow(12, 0),
      // JobAI extras
      "CommandOrControl+Shift+\\": () => this.clearSessionMemory(),
      "CommandOrControl+,": () => windowManager.showSettings(),
      "Alt+A": () => windowManager.toggleInteraction(),
    };

    Object.entries(shortcuts).forEach(([accelerator, handler]) => {
      const success = globalShortcut.register(accelerator, handler);
      logger.debug("Global shortcut registered", { accelerator, success });
    });
  }

  setupServiceEventHandlers() {
    speechService.on("recording-started", () => {
      this._ignoreSpeech = false;
      windowManager.handleRecordingStarted();
    });

    speechService.on("recording-stopped", () => {
      windowManager.handleRecordingStopped();
    });

    speechService.on("transcription", (text) => {
      this.handleTranscriptionFragment(text);
    });

    speechService.on("interim-transcription", (text) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("interim-transcription", { text });
      });
    });

    speechService.on("status", (status) => {
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-status", { status, available: this.speechAvailable });
      });
      // Also broadcast availability specifically
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-availability", { available: this.speechAvailable });
      });
    });

    speechService.on("error", (error) => {
      // In error, still compute availability
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-error", { error, available: this.speechAvailable });
      });
    });
  }

  setupIPCHandlers() {
  ipcMain.handle("take-screenshot", () => this.triggerScreenshotOCR());
  ipcMain.handle("list-displays", () => captureService.listDisplays());
  ipcMain.handle("capture-area", (event, options) => captureService.captureAndProcess(options));

    // Provide reliable clipboard write via main process
    ipcMain.handle("copy-to-clipboard", (event, text) => {
      try {
        const { clipboard } = require("electron");
        clipboard.writeText(String(text ?? ""));
        return true;
      } catch (e) {
        logger.error("Failed to write to clipboard", { error: e.message });
        return false;
      }
    });

    ipcMain.handle("get-speech-availability", () => {
      return speechService.isAvailable ? speechService.isAvailable() : false;
    });

    ipcMain.handle("start-speech-recognition", () => {
      speechService.startRecording();
      return speechService.getStatus();
    });

    ipcMain.handle("stop-speech-recognition", () => {
      this.stopAutoMode("panel");
      return speechService.getStatus();
    });

    // Raw PCM audio captured by the renderer's Web Audio API (Windows Whisper path)
    ipcMain.on("audio-chunk", (_event, data) => {
      if (data && data.buffer) {
        speechService.handleAudioChunkFromRenderer(Buffer.from(data.buffer));
      }
    });

    // Also handle direct send events for fallback
    ipcMain.on("start-speech-recognition", () => {
      speechService.startRecording();
    });

    ipcMain.on("stop-speech-recognition", () => {
      this.stopAutoMode("panel");
    });

    ipcMain.on("main-window-ready", () => {
      // Re-check availability whenever the main overlay finishes loading;
      // this covers first-run where the window was hidden during onboarding.
      this.speechAvailable = speechService.isAvailable
        ? speechService.isAvailable()
        : false;
      const { BrowserWindow } = require("electron");
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send("speech-availability", { available: this.speechAvailable });
        }
      });
    });

    ipcMain.handle("show-all-windows", () => {
      windowManager.showAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("hide-all-windows", () => {
      windowManager.hideAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("enable-window-interaction", () => {
      windowManager.setInteractive(true);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("disable-window-interaction", () => {
      windowManager.setInteractive(false);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("resize-window", (event, { width, height }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        const cfg = windowManager.windowConfigs?.main || {};
        const minW = cfg.minWidth || 60;
        const maxW = cfg.maxWidth || cfg.width || 520;
        const minH = cfg.minHeight || 1;
        const clampedWidth = Math.max(minW, Math.min(maxW, Math.round(width || minW)));
        const clampedHeight = Math.max(minH, Math.round(height || minH));
        try {
          // Keep the panel centred on its current middle so a size change
          // grows it evenly instead of drifting right, and keep it on screen.
          const bounds = mainWindow.getBounds();
          const display = require("electron").screen.getDisplayMatching(bounds);
          const area = display.workArea;
          const centerX = bounds.x + bounds.width / 2;
          const x = Math.round(Math.max(area.x, Math.min(area.x + area.width - clampedWidth, centerX - clampedWidth / 2)));
          const y = Math.round(Math.max(area.y, Math.min(area.y + area.height - clampedHeight, bounds.y)));
          mainWindow.setContentSize(clampedWidth, clampedHeight);
          mainWindow.setPosition(x, y);
        } catch (e) {
          mainWindow.setSize(clampedWidth, clampedHeight);
        }
        logger.debug("Main window resized (content)", { width: clampedWidth, height: clampedHeight });
      }
      return { success: true };
    });

    ipcMain.handle("get-session-history", () => {
      return sessionManager.getOptimizedHistory();
    });

    ipcMain.handle("clear-session-memory", () => {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      return { success: true };
    });

    ipcMain.handle("send-chat-message", async (event, text) => {
      // Add chat message to session memory
      sessionManager.addUserInput(text, 'chat');
      logger.debug('Chat message added to session memory', { textLength: text.length });

      // Typed messages need the full skill pipeline (with history context),
      // NOT the voice "intelligent filter" pipeline. Voice keeps its filter
      // behaviour; typed chat goes through processWithLLM so it gets real
      // answers using the active skill prompt and recent conversation history.
      (async () => {
        try {
          const sessionHistory = sessionManager.getOptimizedHistory();
          await this.processWithLLM(text, sessionHistory);
        } catch (error) {
          logger.error("Failed to process chat message with LLM", {
            error: error.message,
            text: text.substring(0, 100)
          });
        }
      })();

      return { success: true };
    });

    ipcMain.handle("get-skill-prompt", (event, skillName) => {
      try {
        const { promptLoader } = require('./prompt-loader');
        const skillPrompt = promptLoader.getSkillPrompt(skillName);
        return skillPrompt;
      } catch (error) {
        logger.error('Failed to get skill prompt', { skillName, error: error.message });
        return null;
      }
    });

    // Fallbacks and failures from the LLM service show up in the panel status line.
    llmService.noticeHandler = (notice) => {
      windowManager.broadcastToAllWindows("llm-notice", notice);
    };

    ipcMain.handle("set-gemini-api-key", (event, apiKey) => {
      llmService.updateApiKey(apiKey);
      return llmService.getStats();
    });

    // Provider and model that answer in the current mode (shown on the panel).
    ipcMain.handle("get-active-model", () => {
      try {
        return llmService.getActiveModel(this.activeSkill);
      } catch (e) {
        return null;
      }
    });

    ipcMain.handle("get-gemini-status", () => {
      return llmService.getStats();
    });

    ipcMain.handle("get-window-stats", () => {
      return windowManager.getWindowStats();
    });

    // Custom-provider checks from Settings. They take the values currently
    // typed in the form, so nothing has to be saved first.
    ipcMain.handle("gateway-list-models", (_e, o) => llmService.listGatewayModels(o || {}));
    ipcMain.handle("gateway-auto-pick", (_e, o) => llmService.autoPickModels(o || {}, { freeOnly: !!(o && o.freeOnly) }));
    ipcMain.handle("gateway-test-api", (_e, o) => llmService.testGatewayApi(o || {}));
    ipcMain.handle("gateway-test-model", (_e, model, o) => llmService.testGatewayModel(model, o || {}));

    ipcMain.handle("test-gemini-connection", async () => {
      return await llmService.testConnection();
    });

    ipcMain.handle("run-gemini-diagnostics", async () => {
      try {
        const connectivity = await llmService.checkNetworkConnectivity();
        const apiTest = await llmService.testConnection();

        return {
          success: true,
          connectivity,
          apiTest,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
    });

    // Settings handlers
    ipcMain.handle("show-settings", () => {
      windowManager.showSettings();

      // Send current settings to the settings window
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        const currentSettings = this.getSettings();
        setTimeout(() => {
          settingsWindow.webContents.send("load-settings", currentSettings);
        }, 100);
      }

      return { success: true };
    });

    ipcMain.handle("get-settings", () => {
      return this.getSettings();
    });

    // First-run onboarding status — renderer can query to know whether
    // to show the welcome banner / prompt for API-key entry.
    ipcMain.handle("get-first-run-status", () => {
      try {
        return this.firstRunManager.getStatus();
      } catch (e) {
        logger.warn("Failed to get first-run status", { error: e.message });
        return { needsOnboarding: false, error: e.message };
      }
    });

    ipcMain.handle("complete-first-run", async () => {
      try {
        this.firstRunManager.markCompleted();
        this.isFirstRun = false;
        // Reinitialize speech service with the latest persisted settings
        // so the mic button reflects the provider/command set during onboarding.
        speechService.initializeClient();
        this.speechAvailable = speechService.isAvailable
          ? speechService.isAvailable()
          : false;
        // Show the main overlay window now that onboarding is done
        // and API keys are configured.
        await windowManager.showMainWindow();
        // Broadcast speech availability so the mic button appears
        const { BrowserWindow } = require("electron");
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("speech-availability", { available: this.speechAvailable });
          }
        });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Open a URL in the system browser (used by the GitHub star button
    // in onboarding).
    ipcMain.handle("open-external", async (_event, url) => {
      try {
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
          return { ok: false, error: "Invalid URL" };
        }
        const { shell } = require("electron");
        await shell.openExternal(url);
        return { ok: true };
      } catch (e) {
        logger.warn("Failed to open external URL", { url, error: e.message });
        return { ok: false, error: e.message };
      }
    });

    // Close the wizard without finishing it (the X button). Without a Gemini
    // key (required) the app cannot answer anything, so closing setup quits;
    // with one already saved, the overlay opens as usual. The first-run
    // sentinel is not written, so setup is offered again next launch.
    ipcMain.handle("dismiss-onboarding", async () => {
      try {
        windowManager.closeOnboarding();
        if (this.firstRunManager.needsOnboarding() && !llmService.hasValidKey("GEMINI")) {
          logger.info("Setup closed without a Gemini key, quitting");
          app.quit();
          return { success: true, quit: true };
        }
        this.isFirstRun = false;
        await windowManager.showMainWindow();
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Close the onboarding wizard window.
    ipcMain.handle("close-onboarding", () => {
      try {
        windowManager.closeOnboarding();
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Detect an installed Whisper CLI across common locations.
    ipcMain.handle("detect-whisper", async () => {
      try {
        const installer = this.getWhisperInstaller();
        return await installer.detect();
      } catch (e) {
        logger.warn("Whisper detection failed", { error: e.message });
        return { found: false, command: null, version: null, error: e.message };
      }
    });

    // Install Whisper. Streams progress lines back via `webContents.send`
    // so the renderer can paint them as they arrive.
    ipcMain.handle("install-whisper", async (event) => {
      try {
        const installer = this.getWhisperInstaller();
        const sender = event.sender;
        const result = await installer.install({
          onProgress: (line) => {
            try { sender.send("install-progress", line); } catch (_) { /* ignore */ }
          },
        });
        return result;
      } catch (e) {
        logger.error("Whisper install failed", { error: e.message });
        return { ok: false, command: null, message: e.message, logs: "" };
      }
    });

    // Local OCR (reads screenshots when no AI model can). The language data is
    // a small one-time download, offered in the setup wizard.
    ipcMain.handle("ocr-status", () => ({
      installed: ocrService.isInstalled(),
      enabled: ocrService.enabled(),
      dir: ocrService.dataDir(),
    }));
    ipcMain.handle("install-ocr", async (event) => {
      try {
        const sender = event.sender;
        return await ocrService.install((line) => {
          try { sender.send("install-progress", line); } catch (_) { /* ignore */ }
        });
      } catch (e) {
        logger.error("OCR install failed", { error: e.message });
        return { ok: false, message: e.message };
      }
    });
    app.on("before-quit", () => { ocrService.shutdown(); });

    // Download Whisper model. Streams progress lines back via `webContents.send`
    ipcMain.handle("download-whisper-model", async (event, modelName) => {
      try {
        const installer = this.getWhisperInstaller();
        const sender = event.sender;
        const result = await installer.downloadModel(modelName || 'small', {
          onProgress: (line) => {
            try { sender.send("install-progress", line); } catch (_) { /* ignore */ }
          },
        });
        return result;
      } catch (e) {
        logger.error("Whisper model download failed", { error: e.message });
        return { ok: false, message: e.message, path: null };
      }
    });

    ipcMain.handle("save-settings", (event, settings) => {
      return this.saveSettings(settings);
    });

    ipcMain.handle("update-app-icon", (event, iconKey) => {
      return this.updateAppIcon(iconKey);
    });

    ipcMain.handle("update-active-skill", (event, skill) => {
      this.activeSkill = this.normalizeSkill(skill);
      windowManager.broadcastToAllWindows("skill-changed", { skill: this.activeSkill });
      return { success: true };
    });

    ipcMain.handle("restart-app-for-stealth", () => {
      // Force restart the app to ensure stealth name changes take effect
      const { app } = require("electron");
      app.relaunch();
      app.exit();
    });

    ipcMain.handle("close-window", (event) => {
      const webContents = event.sender;
      const window = windowManager.windows.forEach((win, type) => {
        if (win.webContents === webContents) {
          win.hide();
          return true;
        }
      });
      return { success: true };
    });

    ipcMain.handle("quit-app", () => {
      logger.info("Quit app requested via IPC");
      try {
        // Force quit the application
        const { app } = require("electron");

        // Close all windows first
        windowManager.destroyAllWindows();

        // Unregister shortcuts
        globalShortcut.unregisterAll();

        // Force quit
        app.quit();

        // If the above doesn't work, force exit
        setTimeout(() => {
          process.exit(0);
        }, 2000);
      } catch (error) {
        logger.error("Error during quit:", error);
        process.exit(1);
      }
    });

    // Handle close settings
    ipcMain.on("close-settings", () => {
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        settingsWindow.hide();
      }
    });

    // Handle save settings (synchronous)
    ipcMain.on("save-settings", (event, settings) => {
      this.saveSettings(settings);
    });

    // Handle update skill
    ipcMain.on("update-skill", (event, skill) => {
      this.activeSkill = this.normalizeSkill(skill);
      windowManager.broadcastToAllWindows("skill-updated", { skill: this.activeSkill });
    });

    // Handle quit app (alternative method)
    ipcMain.on("quit-app", () => {
      logger.info("Quit app requested via IPC (on method)");
      try {
        const { app } = require("electron");
        windowManager.destroyAllWindows();
        globalShortcut.unregisterAll();
        app.quit();
        setTimeout(() => process.exit(0), 1000);
      } catch (error) {
        logger.error("Error during quit (on method):", error);
        process.exit(1);
      }
    });
  }

  toggleSpeechRecognition() {
    const isAvailable = typeof speechService.isAvailable === 'function' ? speechService.isAvailable() : !!speechService.getStatus?.().isInitialized;
    if (!isAvailable) {
      logger.warn("Speech recognition unavailable; toggle ignored");
      try {
        windowManager.broadcastToAllWindows("speech-status", { status: 'Speech recognition unavailable', available: false });
        windowManager.broadcastToAllWindows("speech-availability", { available: false });
      } catch (e) {}
      return;
    }
    const currentStatus = speechService.getStatus();
    if (currentStatus.isRecording) {
      this.stopAutoMode("toggle shortcut");
    } else {
      try {
        speechService.startRecording();
        logger.info("Speech recognition started via global shortcut");
      } catch (error) {
        logger.error("Error starting speech recognition:", error);
      }
    }
  }

  clearSessionMemory() {
    try {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      logger.info("Session memory cleared via global shortcut");
    } catch (error) {
      logger.error("Error clearing session memory:", error);
    }
  }

  async triggerScreenshotOCR() {
    if (!this.isReady) {
      logger.warn("Screenshot requested before application ready");
      return;
    }

    const startTime = Date.now();

    try {
  const capture = await captureService.captureAndProcess();

      if (!capture.imageBuffer || !capture.imageBuffer.length) {
        this.broadcastOCRError("Failed to capture screenshot image");
        return;
      }

      // Use image directly with LLM and active skill; do not send chat messages here
      const sessionHistory = sessionManager.getOptimizedHistory();

      const skillsRequiringProgrammingLanguage = ['dsa'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      this._responseSeq = (this._responseSeq || 0) + 1;
      const messageId = `img-${Date.now()}-${this._responseSeq}`;
      windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });

      const llmResult = await llmService.processImageWithSkillStream(
        capture.imageBuffer,
        capture.mimeType || 'image/png',
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isImageAnalysis: true
      });

      this.broadcastTranscriptionLLMResponse(llmResult);
    } catch (error) {
      logger.error("Screenshot OCR process failed", {
        error: error.message,
        duration: Date.now() - startTime,
      });

      this.broadcastOCRError(error.message);

      sessionManager.addConversationEvent({
        role: 'system',
        content: `Screenshot OCR failed: ${error.message}`,
        action: 'ocr_error',
        metadata: {
          error: error.message
        }
      });
    }
  }

  async processWithLLM(text, sessionHistory) {
    try {
      // Add user input to session memory
      sessionManager.addUserInput(text, 'llm_input');

      // Check if current skill needs programming language context
      const skillsRequiringProgrammingLanguage = ['dsa'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      this._responseSeq = (this._responseSeq || 0) + 1;
      const messageId = `chat-${Date.now()}-${this._responseSeq}`;
      windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });
      const llmResult = await llmService.processTextWithSkillStream(
        text,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      logger.info("LLM processing completed, showing response", {
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime,
        responsePreview: llmResult.response.substring(0, 200) + "...",
      });

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });

      this.broadcastTranscriptionLLMResponse(llmResult);
    } catch (error) {
      logger.error("LLM processing failed", {
        error: error.message,
        skill: this.activeSkill,
      });

      sessionManager.addConversationEvent({
        role: 'system',
        content: `LLM processing failed: ${error.message}`,
        action: 'llm_error',
        metadata: {
          error: error.message,
          skill: this.activeSkill
        }
      });

      this.broadcastLLMError(error.message);
    }
  }

  /**
   * Buffer a transcribed fragment and (re)arm the coalesce debounce. Fragments
   * are shown in the UI immediately so speech feels live, but the LLM is only
   * asked once the speaker has actually paused — this is what stops one spoken
   * line from producing two separate, slow answers.
   */
  handleTranscriptionFragment(text) {
    if (this._ignoreSpeech) {
      logger.debug("Ignoring transcript that arrived after auto mode was stopped");
      return;
    }
    const fragment = (text || "").trim();
    if (!fragment) {
      return;
    }

    // Route speech UI events according to the user's response-target setting.
    sessionManager.addUserInput(fragment, 'speech');
    this.sendToVoiceResponseWindows("transcription-received", { text: fragment });

    this._utteranceBuffer = this._utteranceBuffer
      ? `${this._utteranceBuffer} ${fragment}`
      : fragment;

    if (this._utteranceTimer) {
      clearTimeout(this._utteranceTimer);
      this._utteranceTimer = null;
    }

    // Manual capture emits one complete transcript after the user presses stop,
    // so no debounce/coalescing delay is needed.
    if (speechService.isManualCaptureMode()) {
      this.dispatchCoalescedUtterance();
      return;
    }

    this._utteranceTimer = setTimeout(() => {
      this._utteranceTimer = null;
      this.dispatchCoalescedUtterance();
    }, this._utteranceCoalesceMs);
  }

  /**
   * Send the coalesced utterance to the LLM. If a previous dispatch is still
   * running, leave the buffer intact and let that dispatch's completion pick it
   * up — so we never pile up overlapping requests for the same person talking.
   */
  async dispatchCoalescedUtterance() {
    if (this._utteranceDispatchInFlight) {
      return;
    }
    const combined = this._utteranceBuffer.trim();
    if (!combined) {
      return;
    }
    this._utteranceBuffer = "";

    // Live audio is mostly narration, small talk and background noise. Only
    // questions and requests are worth a Gemini call; everything else stays in
    // session memory (added in handleTranscriptionFragment) as context for the
    // next real question. Manual capture is an explicit "answer this" press.
    if (!speechService.isManualCaptureMode() && !this.looksLikeQuestionOrRequest(combined)) {
      logger.debug("Skipping LLM call: transcript is not a question or request", {
        textPreview: combined.substring(0, 100)
      });
      return;
    }

    this._utteranceDispatchInFlight = true;

    try {
      const sessionHistory = sessionManager.getOptimizedHistory();
      await this.processTranscriptionWithLLM(combined, sessionHistory);
    } catch (error) {
      logger.error("Failed to process transcription with LLM", {
        error: error.message,
        text: combined.substring(0, 100)
      });
    } finally {
      this._utteranceDispatchInFlight = false;
      // Anything that arrived while we were busy gets answered now.
      if (this._utteranceBuffer.trim()) {
        this.dispatchCoalescedUtterance();
      }
    }
  }

  /**
   * Cheap local check for "is this addressed to me": a question mark, a
   * question opener, or an imperative request. Set JOBAI_QUESTION_FILTER=false
   * to send every transcript to the model again.
   */
  looksLikeQuestionOrRequest(text) {
    if (process.env.JOBAI_QUESTION_FILTER === "false") {
      return true;
    }
    const clean = String(text || "").trim();
    if (!clean) {
      return false;
    }
    if (clean.includes("?")) {
      return true;
    }
    const lower = clean.toLowerCase();
    // Short commands about what is on screen ("answer it", "solve this", "what is
    // on the screen", "read the question") are requests even with only 2 words.
    const screenCommand = /\b(answer|solve|read|look at|check|help with|fix|explain|describe|review|code|complete|finish)\b.{0,20}\b(it|this|that|these|the question|the problem|the screen|my screen|the code|the page)\b|\b(on|from|at) (the|my) screen\b|\bwhat('s| is| are)? (this|that|it|here)\b/;
    if (screenCommand.test(lower)) {
      return true;
    }
    const wordCount = lower.split(/\s+/).length;
    if (wordCount < 3) {
      return false;
    }
    const opener = /(^|[.!]\s+)(what|what's|whats|why|how|when|where|who|which|whose|can|could|would|should|will|do|does|did|is|are|was|were|have|has|tell|explain|describe|walk|show|give|write|implement|design|solve|find|compare|define|list|suggest|discuss|talk|code|optimi[sz]e|calculate|let's|lets)\b/;
    const phrase = /\b(tell me|walk me through|talk me through|explain|describe|can you|could you|would you|will you|do you|have you|are you|what is|what are|how do|how would|how does|how can|why do|why is|why does|difference between|time complexity|space complexity|your experience|your approach|your thoughts)\b/;
    return opener.test(lower) || phrase.test(lower);
  }

  async processTranscriptionWithLLM(text, sessionHistory) {
    // Hoisted so the catch block can tie a fallback answer to the same UI
    // bubble the streaming start event created; otherwise a total failure
    // leaves an empty streamed bubble stranded next to the fallback message.
    let messageId = null;
    try {
      // Validate input text
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        logger.warn("Skipping LLM processing for empty or invalid transcription", {
          textType: typeof text,
          textLength: text ? text.length : 0
        });
        return;
      }

      const cleanText = text.trim();
      if (cleanText.length < 2) {
        logger.debug("Skipping LLM processing for very short transcription", {
          text: cleanText
        });
        return;
      }

      logger.info("Processing transcription with intelligent LLM response", {
        skill: this.activeSkill,
        textLength: cleanText.length,
        textPreview: cleanText.substring(0, 100) + "..."
      });

      // Check if current skill needs programming language context
      const skillsRequiringProgrammingLanguage = ['dsa'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      // Stream the answer progressively to the configured speech target.
      // A unique messageId ties the start/chunk/final events to one bubble so
      // the UI never duplicates or interleaves concurrent responses.
      this._responseSeq = (this._responseSeq || 0) + 1;
      messageId = `tr-${Date.now()}-${this._responseSeq}`;
      this.sendToVoiceResponseWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });
      // Audio and screen together: the same request carries what was just said
      // and what is on screen right now.
      const screenshot = await this.captureScreenForQuestion();
      const llmResult = await llmService.processTranscriptionWithIntelligentResponseStream(
        cleanText,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          this.sendToVoiceResponseWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        },
        screenshot
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isTranscriptionResponse: true
      });

      this.sendTranscriptionLLMResponseToVoiceTargets(llmResult);

      logger.info("Transcription LLM response completed", {
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime
      });

    } catch (error) {
      logger.error("Transcription LLM processing failed", {
        error: error.message,
        errorStack: error.stack,
        skill: this.activeSkill,
        text: text ? text.substring(0, 100) : 'undefined'
      });

      // Try to provide a fallback response
      try {
        const fallbackResult = llmService.generateIntelligentFallbackResponse(text, this.activeSkill);
        // Carry the streaming messageId so the target replaces the live
        // bubble instead of leaving it stuck and appending a duplicate.
        if (messageId) {
          fallbackResult.metadata = { ...fallbackResult.metadata, messageId };
        }

        sessionManager.addModelResponse(fallbackResult.response, {
          skill: this.activeSkill,
          processingTime: fallbackResult.metadata.processingTime,
          usedFallback: true,
          isTranscriptionResponse: true,
          fallbackReason: error.message
        });

        this.sendTranscriptionLLMResponseToVoiceTargets(fallbackResult);
        logger.info("Used fallback response for transcription", {
          skill: this.activeSkill,
          fallbackResponse: fallbackResult.response
        });

      } catch (fallbackError) {
        logger.error("Fallback response also failed", {
          fallbackError: fallbackError.message
        });

        sessionManager.addConversationEvent({
          role: 'system',
          content: `Transcription LLM processing failed: ${error.message}`,
          action: 'transcription_llm_error',
          metadata: {
            error: error.message,
            skill: this.activeSkill
          }
        });
      }
    }
  }

  broadcastOCRSuccess(ocrResult) {
    windowManager.broadcastToAllWindows("ocr-completed", {
      text: ocrResult.text,
      metadata: ocrResult.metadata,
    });
  }

  broadcastOCRError(errorMessage) {
    windowManager.broadcastToAllWindows("ocr-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastLLMSuccess(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      skill: this.activeSkill, // Add the current active skill to the top level
    };

    logger.info("Broadcasting LLM success to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      dataKeys: Object.keys(broadcastData),
      responsePreview: llmResult.response.substring(0, 100) + "...",
    });

    windowManager.broadcastToAllWindows("llm-response", broadcastData);
  }

  broadcastLLMError(errorMessage) {
    windowManager.broadcastToAllWindows("llm-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastTranscriptionLLMResponse(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      messageId: llmResult.metadata && llmResult.metadata.messageId,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };

    logger.info("Broadcasting transcription LLM response to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      responsePreview: llmResult.response.substring(0, 100) + "..."
    });

    windowManager.broadcastToAllWindows("transcription-llm-response", broadcastData);
  }

  // Stop auto mode: the listening and the automatic screen capture that goes with
  // it. Anything heard but not yet sent to the model is dropped, so nothing is
  // answered (and no screenshot is taken) after the user has stopped. Manual
  // capture mode keeps its own meaning: there, stopping is what submits the
  // recording. Calling this when already stopped does nothing; it never starts.
  stopAutoMode(source = "shortcut") {
    if (!speechService.getStatus().isRecording) {
      logger.debug("Stop auto mode ignored: not listening", { source });
      return false;
    }
    const manualMode = speechService.isManualCaptureMode();
    try {
      speechService.stopRecording();
    } catch (error) {
      logger.error("Error stopping speech recognition:", error);
      return false;
    }
    if (!manualMode) {
      this._ignoreSpeech = true;
      if (this._utteranceTimer) {
        clearTimeout(this._utteranceTimer);
        this._utteranceTimer = null;
      }
      this._utteranceBuffer = "";
    }
    logger.info("Auto mode stopped", { source });
    return true;
  }

  isAutoScreenEnabled() {
    return String(process.env.JOBAI_AUTO_SCREEN ?? "true").trim().toLowerCase() !== "false";
  }

  // Capture the screen when a spoken question is answered so the answer can use
  // what is visible (a problem statement, code, a diagram). This never blocks the
  // answer: a failed or slow capture simply means a text-only request.
  async captureScreenForQuestion() {
    if (!this.isAutoScreenEnabled()) {
      return null;
    }
    try {
      const capture = await Promise.race([
        captureService.captureAndProcess(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("capture timed out")), 4000)),
      ]);
      if (!capture || !capture.imageBuffer || !capture.imageBuffer.length) {
        return null;
      }
      return { imageBuffer: capture.imageBuffer, mimeType: capture.mimeType || "image/png" };
    } catch (error) {
      logger.warn("Auto screen capture skipped", { error: error.message });
      return null;
    }
  }

  // JobAI has two skills: "dsa" and "interview" (everything else maps to it).
  normalizeSkill(skill) {
    const { promptLoader } = require("./prompt-loader");
    return promptLoader.normalizeSkillName(skill);
  }

  syncPreferredLanguage() {
    const { promptLoader } = require("./prompt-loader");
    promptLoader.setPreferredLanguage(this.codingLanguage);
  }

  toggleSettingsWindow() {
    const settingsWindow = windowManager.getWindow("settings");
    if (settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.isVisible()) {
      windowManager.hideSettings();
    } else {
      windowManager.showSettings();
    }
  }

  // Ctrl+Arrow nudges the panel (12 px a step, repeating while the keys are
  // held) and keeps it fully on the screen it is on.
  moveMainWindow(deltaX, deltaY) {
    const mainWindow = windowManager.getWindow("main");
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) {
      return;
    }
    const { screen } = require("electron");
    const bounds = mainWindow.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const maxX = Math.max(area.x, area.x + area.width - bounds.width);
    const maxY = Math.max(area.y, area.y + area.height - bounds.height);
    const x = Math.min(maxX, Math.max(area.x, bounds.x + deltaX));
    const y = Math.min(maxY, Math.max(area.y, bounds.y + deltaY));
    if (x !== bounds.x || y !== bounds.y) {
      mainWindow.setPosition(x, y);
    }
  }

  focusPanelInput() {
    const mainWindow = windowManager.getWindow("main");
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    windowManager.showOnCurrentDesktop(mainWindow);
    mainWindow.focus();
    mainWindow.webContents.send("focus-input");
  }

  // Speech answers are shown in the panel, which is the main window.
  sendToVoiceResponseWindows(channel, data) {
    const mainWindow = windowManager.getWindow("main");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  }

  sendTranscriptionLLMResponseToVoiceTargets(llmResult) {
    const data = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      messageId: llmResult.metadata && llmResult.metadata.messageId,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };
    this.sendToVoiceResponseWindows("transcription-llm-response", data);
  }

  onWindowAllClosed() {
    if (process.platform !== "darwin") {
      app.quit();
    }
  }

  onActivate() {
    if (!this.isReady && !this.starting) {
      this.onAppReady();
    } else if (this.isReady) {
      // When app is activated, ensure windows appear on current desktop
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow && mainWindow.isVisible()) {
        windowManager.showOnCurrentDesktop(mainWindow);
      }

      // Also handle other visible windows
      windowManager.windows.forEach((window, type) => {
        if (window.isVisible()) {
          windowManager.showOnCurrentDesktop(window);
        }
      });

      logger.debug("App activated - ensured windows appear on current desktop");
    }
  }

  onWillQuit() {
    globalShortcut.unregisterAll();
    speechService.shutdown();
    windowManager.destroyAllWindows();

    const sessionStats = sessionManager.getMemoryUsage();
    logger.info("Application shutting down", {
      sessionEvents: sessionStats.eventCount,
      sessionSize: sessionStats.approximateSize,
    });
  }

  getWhisperInstaller() {
    if (!this._whisperInstaller) {
      const WhisperInstaller = require("./src/core/whisper-installer");
      const { app } = require("electron");
      this._whisperInstaller = new WhisperInstaller({
        cwd: process.cwd(),
        dataDir: app.getPath("userData"),
        platform: process.platform,
      });
    }
    return this._whisperInstaller;
  }

  getSettings() {
    // Surface every value the settings UI can edit, reading the live source
    // of truth (process.env) so the UI shows exactly what the running app is
    // using. Empty strings are returned rather than skipped so the UI can
    // distinguish "unset" from "stale value from a previous load".
    return {
      codingLanguage: this.codingLanguage || "cpp",
      activeSkill: this.activeSkill || "dsa",
      appIcon: this.appIcon || "terminal",
      selectedIcon: this.appIcon || "terminal",
      autoScreen: this.isAutoScreenEnabled(),

      speechProvider: speechService.provider || "whisper",
      azureKey: process.env.AZURE_SPEECH_KEY || "",
      azureRegion: process.env.AZURE_SPEECH_REGION || "",
      whisperCommand: process.env.WHISPER_COMMAND || "",
      whisperModel: process.env.WHISPER_MODEL || "small",
      whisperLanguage: process.env.WHISPER_LANGUAGE || "auto",
      whisperDevice: process.env.WHISPER_DEVICE || "auto",
      whisperCaptureMode: process.env.WHISPER_CAPTURE_MODE ||
        (process.env.WHISPER_MANUAL_CAPTURE === "true" ? "manual" : "vad"),
      whisperSegmentMs: process.env.WHISPER_SEGMENT_MS || "4000",
      geminiKey: process.env.GEMINI_API_KEY || "",
      gatewayKey: process.env.GATEWAY_API_KEY || "",
      gatewayModels: process.env.GATEWAY_MODELS || "",
      gatewayEffort: process.env.GATEWAY_EFFORT || "",
      gatewayDiscovery: (process.env.GATEWAY_DISCOVERY || "").toLowerCase() === "true",
      gatewayFreeOnly: (process.env.GATEWAY_FREE_ONLY || "").toLowerCase() === "true",
      gatewayBaseUrl: process.env.GATEWAY_BASE_URL || "",
      gatewayAuth: process.env.GATEWAY_AUTH || "",
      gatewayFormat: process.env.GATEWAY_FORMAT || "",
      llmProvider: llmService.provider || "gemini",
      llmRouting: (process.env.LLM_ROUTING || "auto").toLowerCase() === "off" ? "off" : "auto",

      azureConfigured: !!process.env.AZURE_SPEECH_KEY && !!process.env.AZURE_SPEECH_REGION,
      speechAvailable: this.speechAvailable
    };
  }

  saveSettings(settings) {
    try {
      // ── In-memory updates + window broadcasts ──
      if (settings.codingLanguage) {
        this.codingLanguage = settings.codingLanguage;
        this.syncPreferredLanguage();
        windowManager.broadcastToAllWindows("coding-language-changed", {
          language: settings.codingLanguage,
        });
      }
      if (settings.activeSkill) {
        this.activeSkill = this.normalizeSkill(settings.activeSkill);
        windowManager.broadcastToAllWindows("skill-updated", {
          skill: this.activeSkill,
        });
      }
      if (settings.appIcon) {
        this.appIcon = settings.appIcon;
      }
      const prefUpdates = {};
      if (CODING_LANGUAGES.includes(settings.codingLanguage)) {
        prefUpdates.JOBAI_CODING_LANGUAGE = settings.codingLanguage;
      }
      if (settings.activeSkill) {
        prefUpdates.JOBAI_ACTIVE_SKILL = this.normalizeSkill(settings.activeSkill);
      }
      if (typeof settings.autoScreen === "boolean") {
        prefUpdates.JOBAI_AUTO_SCREEN = String(settings.autoScreen);
      }
      if (Object.keys(prefUpdates).length) this.persistEnvUpdates(prefUpdates);
      if (settings.selectedIcon) {
        this.appIcon = settings.selectedIcon;
        this.updateAppIcon(settings.selectedIcon);
      }

      // ── Persist provider / API-key fields back to .env ──
      // The settings UI is now the source of truth for these values.
      // Writing to .env ensures they survive app restarts and are picked
      // up the next time the app boots.
      const envUpdates = {};
      if (settings.speechProvider === "azure" || settings.speechProvider === "whisper") {
        envUpdates.SPEECH_PROVIDER = settings.speechProvider;
      }
      if (settings.azureKey !== undefined) {
        envUpdates.AZURE_SPEECH_KEY = settings.azureKey;
      }
      if (settings.azureRegion !== undefined) {
        envUpdates.AZURE_SPEECH_REGION = settings.azureRegion;
      }
      if (settings.whisperCommand !== undefined) {
        envUpdates.WHISPER_COMMAND = settings.whisperCommand;
      }
      if (settings.whisperModel !== undefined) {
        envUpdates.WHISPER_MODEL = settings.whisperModel;
      }
      if (settings.whisperLanguage !== undefined) {
        envUpdates.WHISPER_LANGUAGE = settings.whisperLanguage;
      }
      if (["auto", "cpu", "cuda"].includes(settings.whisperDevice)) {
        envUpdates.WHISPER_DEVICE = settings.whisperDevice;
      }
      if (["manual", "vad"].includes(settings.whisperCaptureMode)) {
        envUpdates.WHISPER_CAPTURE_MODE = settings.whisperCaptureMode;
      }
      if (settings.whisperSegmentMs !== undefined) {
        envUpdates.WHISPER_SEGMENT_MS = String(settings.whisperSegmentMs);
      }
      if (settings.geminiKey !== undefined) {
        envUpdates.GEMINI_API_KEY = settings.geminiKey;
      }
      // onboarding.js still sends the old anthropicKey / "anthropic" names.
      const gatewayKey = settings.gatewayKey !== undefined ? settings.gatewayKey : settings.anthropicKey;
      if (gatewayKey !== undefined) {
        envUpdates.GATEWAY_API_KEY = gatewayKey;
      }
      if (settings.gatewayModels !== undefined) {
        envUpdates.GATEWAY_MODELS = String(settings.gatewayModels).split(/[\s,]+/).filter(Boolean).join(",");
      }
      if (["", "low", "medium", "high", "xhigh", "max"].includes(settings.gatewayEffort)) {
        envUpdates.GATEWAY_EFFORT = settings.gatewayEffort;
      }
      if (typeof settings.gatewayDiscovery === "boolean") {
        envUpdates.GATEWAY_DISCOVERY = String(settings.gatewayDiscovery);
      }
      if (typeof settings.gatewayFreeOnly === "boolean") {
        envUpdates.GATEWAY_FREE_ONLY = String(settings.gatewayFreeOnly);
      }
      if (settings.gatewayBaseUrl !== undefined) {
        envUpdates.GATEWAY_BASE_URL = settings.gatewayBaseUrl;
      }
      if (["", "x-api-key", "bearer"].includes(settings.gatewayAuth)) {
        envUpdates.GATEWAY_AUTH = settings.gatewayAuth;
      }
      if (["", "anthropic", "openai"].includes(settings.gatewayFormat)) {
        envUpdates.GATEWAY_FORMAT = settings.gatewayFormat;
      }
      const provider = settings.llmProvider === "anthropic" ? "gateway" : settings.llmProvider;
      if (provider === "gemini" || provider === "gateway") {
        envUpdates.LLM_PROVIDER = provider;
      }
      if (settings.llmRouting === "auto" || settings.llmRouting === "off") {
        envUpdates.LLM_ROUTING = settings.llmRouting;
      }

      // Capture the previous whisper command BEFORE persisting — persistEnvUpdates
      // mutates process.env in place, so comparing afterwards would always read
      // equal and skip the speech re-init below (the exact stale-mic-after-install
      // bug the re-init guards against).
      const prevWhisperCommand = process.env.WHISPER_COMMAND || '';

      const persistedKeys = this.persistEnvUpdates(envUpdates);

      // If the Gemini key was just saved, reinitialize the LLM service
      // so the new client picks up the key. Without this, the test-
      // connection button in the onboarding wizard fails with
      // "Service not initialized" because the client was first created
      // at app startup, before any key was set.
      const llmKeys = ["GEMINI_API_KEY", "GATEWAY_API_KEY", "GATEWAY_MODELS", "GATEWAY_EFFORT", "GATEWAY_DISCOVERY", "GATEWAY_FREE_ONLY", "GATEWAY_BASE_URL", "GATEWAY_AUTH", "GATEWAY_FORMAT", "LLM_PROVIDER"];
      if (llmKeys.some((k) => envUpdates[k] !== undefined)) {
        try {
          llmService.initializeClient();
          logger.info("LLM service reinitialized after LLM settings update", {
            provider: llmService.provider
          });
        } catch (e) {
          logger.warn("Failed to reinitialize LLM service after LLM settings update", {
            error: e.message
          });
        }
      }

      // Reinitialize speech service when provider OR whisper command
      // changes. Without the second check, the install flow (which
      // writes a new whisperCommand after install but keeps the same
      // provider) would leave the speech service pointing at a stale
      // (or non-existent) binary, and the main overlay's mic button
      // would stay hidden / non-functional.
      const providerChanged = settings.speechProvider && speechService.provider !== settings.speechProvider;
      const whisperCommandChanged = settings.whisperCommand !== undefined &&
        prevWhisperCommand !== String(settings.whisperCommand || '');
      if (providerChanged || whisperCommandChanged) {
        try {
          speechService.initializeClient();
          this.speechAvailable = speechService.isAvailable
            ? speechService.isAvailable()
            : false;
          // Broadcast so any open window (settings, panel)
          // can react immediately — especially the main overlay's
          // Listen tab, which queries availability on load.
          const { BrowserWindow } = require("electron");
          BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
              win.webContents.send("speech-availability", { available: this.speechAvailable });
            }
          });
          logger.info('Speech service reinitialized after settings change', {
            providerChanged,
            whisperCommandChanged,
            speechAvailable: this.speechAvailable,
          });
        } catch (e) {
          logger.warn("Failed to reinitialize speech service after settings change", {
            error: e.message
          });
        }
      }

      logger.info("Settings saved successfully", {
        ...settings,
        persistedEnvKeys: persistedKeys
      });
      return { success: true, persistedEnvKeys: persistedKeys };
    } catch (error) {
      logger.error("Failed to save settings", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  persistSettings(settings) {
    // You can extend this to save to a file or database
    // For now, we'll just keep them in memory
    logger.debug("Settings persisted", settings);
  }

  /**
   * Write key=value pairs to the project's .env file. Existing keys are
   * replaced in-place; new keys are appended. Comments and unrelated lines
   * are preserved. Uses an atomic write (temp file + rename) so a crash
   * mid-write cannot corrupt .env.
   *
   * @param {Object<string, string>} updates - keys to upsert
   * @returns {string[]} keys that were actually persisted
   */
  persistEnvUpdates(updates) {
    if (!updates || typeof updates !== "object") return [];
    const keys = Object.keys(updates);
    if (keys.length === 0) return [];

    const fs = require("fs");
    // Single source of truth — the same file dotenv loaded at startup and that
    // FirstRunManager reads/writes (userData in packaged builds, project .env
    // in dev). Writing to process.cwd() here would silently diverge.
    const envPath = ENV_PATH;

    let existing = "";
    try {
      existing = fs.readFileSync(envPath, "utf8");
    } catch (_) {
      // .env doesn't exist yet — we'll create one from scratch
      existing = "";
    }

    // Secrets go to the OS keychain; their .env line is left empty. If the
    // keychain is unavailable they stay in .env as before.
    const fileUpdates = { ...updates };
    for (const key of keys) {
      if (secureStore.isSecret(key) && secureStore.set(key, updates[key])) fileUpdates[key] = "";
    }

    const existingLines = existing.length > 0 ? existing.split(/\r?\n/) : [];
    const updated = new Set();
    const outLines = [];

    for (const line of existingLines) {
      // Match "KEY=" (with optional whitespace) but skip comment lines
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
      if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
        const key = m[1];
        outLines.push(`${key}=${formatEnvValue(fileUpdates[key])}`);
        updated.add(key);
      } else {
        outLines.push(line);
      }
    }

    // Append any keys that weren't already present
    for (const key of keys) {
      if (!updated.has(key)) {
        outLines.push(`${key}=${formatEnvValue(fileUpdates[key])}`);
        updated.add(key);
      }
    }

    // Update process.env so the running app picks up the new values
    // immediately (and so the settings UI reads the same source of truth).
    for (const key of keys) {
      process.env[key] = String(updates[key]);
    }

    const newContent = outLines.join("\n");
    try {
      const tmpPath = envPath + ".tmp";
      fs.writeFileSync(tmpPath, newContent, "utf8");
      fs.renameSync(tmpPath, envPath);
    } catch (e) {
      logger.error("Failed to persist .env updates", {
        error: e.message,
        keys
      });
      return [];
    }

    logger.info("Persisted .env updates", { keys: Array.from(updated) });
    return Array.from(updated);
  }

  updateAppIcon(iconKey) {
    try {
      const { app } = require("electron");
      const path = require("path");
      const fs = require("fs");

      // Icon mapping for available icons in assests/icons folder
      const iconPaths = {
        terminal: "assests/icons/terminal.png",
        activity: "assests/icons/activity.png",
        settings: "assests/icons/settings.png",
      };

      // App name mapping for stealth mode
      const appNames = {
        terminal: "Terminal ",
        activity: "Activity Monitor ",
        settings: "System Settings ",
      };

      const iconPath = iconPaths[iconKey];
      const appName = appNames[iconKey];

      if (!iconPath) {
        logger.error("Invalid icon key", { iconKey });
        return { success: false, error: "Invalid icon key" };
      }

      const fullIconPath = path.resolve(__dirname, iconPath);

      if (!fs.existsSync(fullIconPath)) {
        logger.error("Icon file not found", {
          iconKey,
          iconPath: fullIconPath,
        });
        return { success: false, error: "Icon file not found" };
      }

      // Set app icon for dock/taskbar
      if (process.platform === "darwin") {
        // macOS - update dock icon (only if dock is available)
        if (app.dock) {
          app.dock.setIcon(fullIconPath);

          // Force dock refresh with multiple attempts
          const retryDockIcon = () => {
            try { app.dock.setIcon(fullIconPath); } catch (_) { /* dock may not exist */ }
          };
          setTimeout(retryDockIcon, 100);
          setTimeout(retryDockIcon, 500);
        }
      } else {
        // Windows/Linux - update window icons
        windowManager.windows.forEach((window, type) => {
          if (window && !window.isDestroyed()) {
            window.setIcon(fullIconPath);
          }
        });
      }

      // Update app name for stealth mode
      this.updateAppName(appName, iconKey);

      logger.info("App icon and name updated successfully", {
        iconKey,
        appName,
        iconPath: fullIconPath,
        platform: process.platform,
        fileExists: fs.existsSync(fullIconPath),
      });

      this.appIcon = iconKey;
      return { success: true };
    } catch (error) {
      logger.error("Failed to update app icon", {
        error: error.message,
        stack: error.stack,
      });
      return { success: false, error: error.message };
    }
  }

  updateAppName(appName, iconKey) {
    try {
      const { app } = require("electron");

      // Force update process title for Activity Monitor stealth - CRITICAL
      process.title = appName;

      // Set app name in dock (macOS) - this affects the dock and Activity Monitor
      if (process.platform === "darwin") {
        // Multiple attempts to ensure the name sticks
        app.setName(appName);

        // Clear dock badge and reset
        if (app.dock) {
          app.dock.setBadge("");
          // Force dock refresh
          setTimeout(() => {
            app.dock.setIcon(
              require("path").resolve(__dirname, `assests/icons/${iconKey}.png`)
            );
          }, 50);
        }
      }

      // Set app user model ID for Windows taskbar grouping (Windows only)
      if (process.platform === "win32") {
        app.setAppUserModelId(`${appName.trim()}-${iconKey}`);
      }

      // Update all window titles to match the new app name
      const windows = windowManager.windows;
      windows.forEach((window, type) => {
        if (window && !window.isDestroyed()) {
          // Use stealth name for all windows
          const stealthTitle = appName.trim();
          window.setTitle(stealthTitle);
        }
      });

      // Multiple force refreshes with increasing delays
      const refreshTimes = [50, 100, 200, 500];
      refreshTimes.forEach((delay) => {
        setTimeout(() => {
          process.title = appName;
          if (process.platform === "darwin") {
            app.setName(appName);
            // Force update bundle display name
            if (app.getName() !== appName) {
              app.setName(appName);
            }
          }
        }, delay);
      });

      logger.info("App name updated for stealth mode", {
        appName,
        processTitle: process.title,
        appGetName: app.getName(),
        iconKey,
        platform: process.platform,
      });
    } catch (error) {
      logger.error("Failed to update app name", { error: error.message });
    }
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  const controller = new ApplicationController();
  app.on("second-instance", () => controller.handleSecondInstance());
}
