<div align="center">

# JobAI

**The invisible AI interview copilot.**

Real-time AI help on a stealth overlay that screen sharing cannot see. Ask by voice or screenshot, and get clear answers that stream in as you need them.

<a href="#download">Download</a> &nbsp;|&nbsp;
<a href="#quick-start">Quick start</a> &nbsp;|&nbsp;
<a href="#how-it-works">How it works</a>

</div>

## What it is

JobAI is a desktop app for technical interviews and practice. It places a small overlay on your screen that recording and conferencing tools do not capture. You can speak a question or take a screenshot, and the AI answers in real time. Everything lives in one panel: the live transcript, the streamed answer with clean code blocks and syntax highlighting, follow-up chips and an input box.

It is free and open source. Processing stays on your machine, and the only thing that leaves your device is the request you send to the AI provider.

## Highlights

- **Invisible overlay.** Windows stay out of Zoom, Google Meet, Microsoft Teams, Discord, and OBS captures. You see the answer, the call does not.
- **Hidden during screen share.** When a share starts, the app can hide every window on its own.
- **Flexible local voice.** Choose manual start/stop capture or automatic voice-activity detection without fixed-timer sentence cuts.
- **Auto mode.** With recording on, JobAI listens for questions and requests. When it hears one, such as "answer it", "solve this" or "what is on the screen", it captures your screen, reads the text on it with local OCR, and sends the screenshot, that text and your spoken words together, so you never need the screenshot shortcut. One Stop button stops listening and screen capture together. To send only the spoken text, turn off "Read the screen on spoken questions" in Settings (or set `JOBAI_AUTO_SCREEN=false` in `.env`).
- **One panel.** Transcript, answers, follow-ups and input in a single window, with S/M/L/XL sizes and an adjustable transparency slider.
- **Image and text together.** Screenshots go to a model that can read images, and the text OCR reads from the screen goes with them, so even a model that cannot see images can answer.
- **Session memory.** The whole conversation is remembered, so follow-ups, edge cases, and optimizations keep their context.
- **Two answer modes.** DSA for coding problems, and Interview for everything else: behavioral, system design, technical concepts, DevOps, data science and negotiation.
- **Language aware.** Tailored answers for C++, C, Python, Java, and JavaScript.
- **Stealthy by design.** Runs under ordinary system names, ships with no telemetry, and keeps your session local.
- **Cross platform.** Runs from source on Windows, macOS and Linux. You can build an installer for your own OS (see [Download](#download)).

## Download

There are no pre-built installers yet. Run from source (see [Quick start](#quick-start)) or build one yourself with `./setup.sh --build`.

## Quick start

Four steps.

1. Open a terminal in the project folder.

   ```bash
   cd OpenCluely
   ```

2. Create your `.env` file from the example. `env.example` lists every option with a comment, so copy it first and edit the values you want.

   ```bash
   cp env.example .env          # macOS, Linux, Git Bash
   copy env.example .env        # Windows Command Prompt
   Copy-Item env.example .env   # Windows PowerShell
   ```

   `./setup.sh` and `npm run setup` do this copy for you when `.env` is missing. Never commit `.env`.

3. Install and run.

   ```bash
   ./setup.sh
   ```

   The script installs Node dependencies, creates `.env` if you skipped step 2, sets up a local Whisper virtual environment, points the config at it, and launches the app. Prefer plain npm? Run `npm install`, then `npm start`.

4. Follow the setup wizard.

   On first launch a wizard opens with these screens:

   | Screen | What you set |
   | --- | --- |
   | Connect your AI | A **Gemini key** (required; free from [Google AI Studio](https://aistudio.google.com/apikey)). Optionally an **other AI**: an OpenRouter or Kilo key, or a `curl` command for any provider. The app reads the URL, key, credential kind and model from the curl command. |
   | Your preferences | Mode (DSA or Interview), coding language, and whether the screen is read automatically when you ask a spoken question. |
   | Read the screen | Download the offline OCR data now (about 2 MB) or on first use. |
   | Speech Recognition | Local Whisper, Azure Speech, or skip. Whisper adds two more screens: setup and the model download. |
   | You're all set | A summary of what was configured. |

   Everything in the wizard can be changed later in Settings (`Ctrl+Shift+D`). Keys you enter are stored in your operating system's keychain, not in `.env`.

### Platform notes

- On Windows, use Git Bash (included with Git for Windows) or WSL to run `setup.sh`.
- On macOS and Linux, your normal terminal works.
- **macOS users must build from source** (steps above) — there is no pre-built `.dmg`. Because the app is unsigned, a downloaded build would be blocked by Gatekeeper as "damaged"; running from source avoids that entirely.
- Prefer plain npm? `npm install`, then `npm run setup` and `npm start` do the same on every OS, including Windows PowerShell.

### Setup script options

```bash
./setup.sh --build                # Build a distributable for your OS
./setup.sh --ci                   # Use npm ci instead of npm install
./setup.sh --no-run               # Set up only, do not launch
./setup.sh --install-system-deps  # Install sox for the microphone (optional)
./setup.sh --skip-whisper         # Skip the local Whisper bootstrap
./setup.sh --skip-ocr             # Skip the OCR language data download
```

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Install dependencies |
| `npm run setup` | Create `.env` from `env.example` if it is missing |
| `npm test` | Run the automated tests (a mock AI provider; no keys or network needed) |
| `npm run test:electron` | Run the tests that need Electron: image shrinking, the keychain, OCR (needs a desktop session) |
| `npm run setup-ocr` | Download the OCR language data (about 2 MB) ahead of time |
| `npm start` | Run the app (any OS) |
| `npm run dev` | Run with `--no-sandbox --disable-gpu` (Linux and headless setups) |
| `npm run build:win` / `build:mac` / `build:linux` | Build an installer for that OS |
| `./setup.sh` | Install, create `.env`, set up Whisper and launch (bash) |

## AI providers

- **Gemini (required).** Answers interview questions and is the automatic fallback.
- **Other AI (optional).** Answers coding questions and screenshots. Works with any OpenAI- or Anthropic-style endpoint: OpenRouter, Kilo, Groq, Ollama, LiteLLM and others. With no model list set, the app finds models that work, uses the best, switches to the next when one fails, and rescans when all of them fail. Screenshots go to models that can read images. If none can, the screenshot is read with local OCR and sent as text (see below).
- **When the other AI fails,** the panel status line shows the error and Gemini answers instead. If OCR finds no text, a spoken question is answered from the words alone.

## Where settings and keys live

| What | Where |
| --- | --- |
| API keys (Gemini, other AI, Azure) | OS keychain: Windows DPAPI, macOS Keychain, Linux Secret Service. Only encrypted values are written to disk, in `secrets.enc.json` in the app data folder. |
| Everything else | `.env` in the app data folder (or the project folder when you run from source and it already has one) |

A key typed into `.env` is moved into the keychain the next time the app starts, and its `.env` line is emptied. On a system with no keychain (Linux without a Secret Service), keys stay in `.env`, so keep that file private.

## Configuration

`env.example` lists every option with comments; copy it to `.env` as shown in the [Quick start](#quick-start). The common ones:

```bash
GEMINI_API_KEY=            # required; kept in the keychain
GATEWAY_API_KEY=           # optional other AI; kept in the keychain
GATEWAY_BASE_URL=https://api.kilo.ai/api/gateway   # or https://openrouter.ai/api/v1
GATEWAY_MODELS=            # empty = find and rotate working models
LLM_PROVIDER=gemini        # gemini | gateway

JOBAI_CODING_LANGUAGE=cpp  # cpp | c | python | java | javascript
JOBAI_ACTIVE_SKILL=dsa     # dsa | interview
JOBAI_AUTO_SCREEN=true     # read the screen when a spoken question is asked

SPEECH_PROVIDER=whisper    # whisper | azure
WHISPER_MODEL=small.en
WHISPER_LANGUAGE=en
WHISPER_CAPTURE_MODE=vad
```

Speech is optional. If no provider is configured, the microphone button hides itself across the app.

## Image support works with any provider

JobAI does not rely on any one provider's model list. To find out which models can read screenshots it asks them: a tiny red square is sent and the model has to name the colour. Models that pass are remembered for a week, those that fail for a day, and among the ones that pass the fastest goes first. Your own screenshot is only ever sent to a model that has passed (or that the provider itself marks as image-capable), never to a guess.

## Privacy and limits

- **Secrets are redacted.** API keys, tokens, private keys and `password=` style values are replaced with `[redacted]` before anything is sent, including text read from the screen. Ordinary code such as `token = tokens[i]` is left alone.
- **Uploads are capped.** At most 30,000 characters of history plus question per request (newest kept, 12,000 per message) and at most two images. Screenshots are shrunk to 1,600 px as JPEG before sending.
- **Logs hold no conversation.** Log files record what happened (timings, model names, errors), not questions, transcripts or answers, and secrets are redacted in them too. `LOG_CONTENT=true` turns content logging on for debugging.
- **Nothing piles up.** At most three requests to the provider run at once and the rest wait; a model that fails is skipped for a few minutes.
- The limits are set in `.env` (see `env.example`).

## Speed

- A failing model is left behind at once: one retry, and only for network trouble. A model that goes silent is dropped after 20 seconds (streaming).
- Models found by discovery, image-support results and response times are remembered between launches in `model-health.json` (model names and timings only), so the app does not re-test them each start.
- The provider connection, the model list and the OCR engine are warmed up in the background after launch.

## Screen reading (OCR)

Not every model can look at a screenshot, and routers such as `openrouter/free` may hand a request to one that cannot. For spoken questions JobAI therefore always sends the text it reads from your screen with local OCR alongside the screenshot. When none of your models can read images, JobAI reads the text on screen with local OCR ([tesseract.js](https://github.com/naptha/tesseract.js)) and sends it with your question, marked as OCR text. It runs offline on your machine. Expect about half a second per screenshot, and note that OCR loses code indentation and diagrams, so a model that can see images answers better.

The English language data is a one-time download of about 2 MB. The setup wizard offers it (like the Whisper model), `./setup.sh` and `npm run setup-ocr` fetch it, and otherwise the app downloads it the first time it is needed. Set `JOBAI_OCR_FALLBACK=false` to turn the fallback off.

## What you need before the wizard

| Need | Why | Install it yourself? |
| --- | --- | --- |
| Node.js (current LTS) | Runs the app | Yes |
| Python 3.10+ (on PATH) | Local Whisper speech-to-text runs in a Python environment | Only if you want local Whisper. Skip it with Azure Speech or no voice. |
| A Gemini API key | Answers questions | Get one free; paste it in the wizard |
| Linux only: `arecord` or `sox` | Microphone capture | Windows and macOS capture the microphone inside the app, with nothing to install |

Screen capture needs nothing extra: it is built into the app. On macOS you must allow Screen Recording and Microphone for the app when the system asks.

## Optional voice setup

The wizard handles Whisper for you:

1. On the Whisper screen it **detects** an existing install (your `WHISPER_COMMAND`, or the `.venv-whisper` environment the app creates) and shows what it found.
2. If none is found, press **Install Whisper now**. It creates a private Python environment and installs `openai-whisper` into it. No admin rights are needed, and the first run can take a few minutes.
3. The next screen offers the model download (the `small` model is about 460 MB) now or on first use.
4. The model, language, device and capture mode you pick are saved to `.env` automatically.

After that, the only thing you provide is your API keys. Whisper itself needs no key.

Auto mode records **system audio**, meaning what your computer plays (the other side of a call), not your microphone. On Windows it uses the default speaker or headphones, so it hears nothing while that output is muted. If you see no transcript, check that the output is not muted and that the call audio plays through the default device.

Prefer the command line? `./setup.sh` does the same: it creates `.venv-whisper`, installs `openai-whisper`, points `.env` at it, creates `.whisper-models` and runs a quick speech test. The app reads its own PCM WAV recordings directly; ffmpeg is only needed when transcribing other audio formats through the CLI fallback.

For Azure Speech instead, create a Speech resource in the [Azure Portal](https://portal.azure.com/), then enter the key and region on the wizard's Speech screen (or set `SPEECH_PROVIDER=azure` with the key and region in `.env`).

## How it works

1. **Ask.** Speak with recording on (automatic pause detection, or manual start/stop in Settings). A question or a short command such as "answer it" captures the screen and reads it for you. You can also press `Ctrl+Shift+S` to capture on demand, or type into the input box.
2. **Reason.** The model gets your words, the screenshot and the text read from it, with the full conversation as context, and works toward a precise answer.
3. **Answer.** Answers stream into the panel as they are written.

## Keyboard shortcuts

| Action | Shortcut | Description |
|---|---|---|
| Screenshot | `Cmd/Ctrl + Shift + S` | Capture the screen and analyze it with Gemini |
| Toggle window | `Cmd/Ctrl + \` | Show or hide JobAI |
| Refocus input box | `Cmd/Ctrl + Shift + I` | Bring JobAI forward and put the cursor in the input |
| Auto mode on/off | `Cmd/Ctrl + Shift + M` | Start or stop listening and automatic screen capture |
| Stop auto mode | `Cmd/Ctrl + Shift + X` | Stop listening and screen capture, and drop any question not yet sent |
| Settings | `Cmd/Ctrl + Shift + D` or `Cmd/Ctrl + ,` | Open or close the settings window |
| Move window | `Cmd/Ctrl + Arrow keys` | Nudge the panel 12 px per step, repeats while held |
| Clear session | `Cmd/Ctrl + Shift + \` | Clear the conversation memory |
| Toggle click through | `Alt + A` | Enable or disable click through |

## Project status

JobAI is under active development. The core is stable and improvements ship regularly.

### Done

- Stealth overlay panel that you can drag, resize and make transparent, with a click through toggle
- Hidden during screen share, with automatic hiding when a share begins
- Screenshot capture with direct Gemini analysis, no OCR step
- Configurable manual or VAD-driven voice capture
- Persistent local Whisper worker with optional CUDA acceleration and idle GPU release
- System-audio listening that answers questions from the other side of a call
- Whisper hallucination filter that drops phantom phrases on silence
- Streamed answers with markdown, tables and syntax highlighting
- Global shortcuts for capture, visibility, interaction, chat, and settings
- Session memory and a full chat UI
- Language picker and a DSA skill prompt
- Optional Azure Speech and local Whisper, with an auto hiding mic button
- Multi-monitor and area capture support
- Window binding and positioning
- Settings management with disguise and stealth modes

### Planned

- Multiple model backends alongside Gemini (OpenAI, Anthropic, local)
- Auto typing of code snippets into editors and IDEs
- Export of conversation history to markdown or PDF
- Deeper stealth, including process name randomization

## Troubleshooting

<details>
<summary>Setup issues</summary>

- **setup.sh will not run.** Make sure you are in the project folder (`cd JobAI`) and that the script is executable (`chmod +x setup.sh`). On Windows, use Git Bash.
- **Setup stops with exit code 130.** That means Ctrl+C was pressed. Run `./setup.sh` again.
- **Node or npm not found.** Install Node.js 18 or newer from [nodejs.org](https://nodejs.org/), restart the terminal, and retry.

</details>

<details>
<summary>App issues</summary>

- **Electron will not start or shows a blank window on Linux.** Try `npm run dev`, and make sure X11 or XWayland is available in headless setups.
- **macOS screen capture does not work.** Grant Screen Recording permission under System Settings, Privacy and Security, then relaunch the app.
- **Windows SmartScreen blocks the app.** Click More info, then Run anyway, or use `npm start` during development.
- **Microphone or voice not working.** Voice is optional. For Azure, add valid keys to `.env`. For Whisper, install `openai-whisper`, `ffmpeg`, and `sox`, then set `SPEECH_PROVIDER=whisper`.

</details>

<details>

<summary> Limitations </summary>

- **Screen-capture invisibility does not work on Linux.** The overlay stays hidden from screen shares and recordings only on **macOS** and **Windows**. This relies on Electron's `setContentProtection`, which maps to `NSWindowSharingNone` on macOS and `WDA_EXCLUDEFROMCAPTURE` on Windows. Electron provides **no equivalent on Linux** (neither X11 nor Wayland), so on Linux the call is a silent no-op and the overlay **will be visible** to anyone you screen-share with. This is a platform limitation, not a bug — there is no window flag on Linux that excludes a window from framebuffer capture. If you need capture-invisibility, run JobAI on macOS or Windows. As a partial workaround on Linux, share a single application window instead of your entire screen, or place the overlay on a monitor you are not sharing.

</details>



## Privacy and ethics

JobAI collects no data and sends no telemetry. Processing happens locally, and your session stays on your device. Requests to the AI provider are encrypted in transit.

The app is built for learning and practice. You are responsible for following the rules of any interview you take and the policies of the companies involved.

## License

Copyright (c) 2026 CodeCraftman2. **All rights reserved.** The source is provided for viewing only: you may not copy, modify, redistribute or reuse it without written permission. See [LICENSE](LICENSE).

Some material comes from other projects and keeps its own license; see [NOTICE](NOTICE).

## Acknowledgments

- [OpenCluely](https://github.com/TechyCSR/OpenCluely) by TechyCSR, which this project builds on (see [NOTICE](NOTICE))
- Google Gemini for the AI reasoning
- Azure Speech and OpenAI Whisper for optional voice input
- Electron for the cross platform desktop runtime
- [Vysper by varun-singhh](https://github.com/varun-singhh/Vysper) for UI and structure inspiration

