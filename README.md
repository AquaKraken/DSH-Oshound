[README.md](https://github.com/user-attachments/files/33861089/README.md)
# O-Sound 🎤🔊

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![npm version](https://img.shields.io/npm/v/dsh-osound.svg)](https://www.npmjs.com/package/dsh-osound)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Windows-only, fully local voice interface for **DeepSeek Harness (DSH)**.

O-Sound adds microphone speech-to-text (Const-me **Whisper**) and assistant
text-to-speech (**Piper**) to DSH's Web UI — a microphone button in the composer,
a speaker button on every assistant message, and a full **Settings → Voice**
control panel with animated SVG icons. No cloud speech APIs, no Python
runtime, no Docker. Both engines run as local Windows binaries; only runtime,
model, and voice downloads touch the network.

**Verified against DeepSeek Harness `v0.2.0-rc.1` / `v0.2.0-rc.2`**.

```
🎤  composer button   →  Const-me Whisper (local main.exe, argv-only, streamed in small windows)
🔊  per-message button →  Piper (local piper.exe, argv-only, pipelined chunk-by-chunk)
⚙   Settings → Voice    →  runtimes, models, voices, filters, behavior, diagnostics
```

## Status (v0.5.1)

- **266 tests passing** across 23 test files (`npm test`).
- Host code (`src/**/*.js`, everything except `src/client/`) is plain
  JavaScript with **no build step** — DSH imports `src/index.js` directly.
- The **client** (browser) bundle is built with esbuild into `lib/client.js`
  and committed to the repository so a fresh install works out of the box.
- **28 scoped animated SVG icons** across Composer, Chat, and Settings
  (including `Switch.svg` toggles), animating on pointer proximity (`56px`
  enter / `80px` leave hysteresis) or while an operation is actively running.
- **Capped concurrent download queue** (`DownloadQueue`, default max 2
  concurrent downloads, FIFO queuing) with live downloading/queued indicators
  and cancel support across runtimes, Whisper models, and Piper voices.
- **Comprehensive Whisper STT filter & Quick-Add UI** with case-insensitive
  matching for non-speech tags (`[Music]`, `(Applause)`, `[Blank Audio]`,
  musical symbols, and subtitle watermarks) plus one-click word/tag rule
  creation in Settings.

## Install

**From npm (recommended):**

```powershell
dsh plugin --profile web add dsh-osound
```

**From GitHub:**

```powershell
dsh plugin --profile web add github:AquaKraken/DSH-Oshound
```

**From a local folder:**

```powershell
dsh plugin --profile web add "C:\path\to\dsh-osound"
```

(Replace `web` with your profile name if different.) Then restart DSH — plugin
installs are picked up on the next start, not hot-reloaded.

**Runtimes** (can be installed from **Settings → Voice → Install runtimes** or manually):

1. **Const-me Whisper** — download
   [`cli.zip` from the `1.12.0` release](https://github.com/Const-me/Whisper/releases/tag/1.12.0),
   extract it so `main.exe` ends up at:
   ```
   %USERPROFILE%\.dsh\runtime\whisper\main.exe
   ```
2. **Piper** (the legacy `rhasspy/piper` binary — **not** `piper1-gpl`,
   which ships no Windows executable) — download
   [`piper_windows_amd64.zip` from the `2023.11.14-2` release](https://github.com/rhasspy/piper/releases/tag/2023.11.14-2),
   extract so you have:
   ```
   %USERPROFILE%\.dsh\runtime\piper\piper.exe
   %USERPROFILE%\.dsh\runtime\piper\espeak-ng-data\   (≈361 files)
   ```
   **Important**: if copying manually, copy `espeak-ng-data` with
   `robocopy <src> <dest> /E`, not `Copy-Item -Recurse` — the latter has been
   observed to silently drop nested files, which breaks Piper's phonemization.

The Settings → Voice page's Diagnostics panel will tell you which runtime or
model is missing if you skip this step — the plugin loads cleanly without
them, it just cannot record or speak until they are installed.

**First run**: open Settings → Voice, download the default Whisper model
(Base — Multilingual, ~148MB) and pick a Piper voice from the cascading
Language → Region → Voice → Quality pickers. Multiple downloads can be queued
at once (up to 2 run concurrently while additional items wait in queue).

## Architecture

```
src/
├── index.js                 entry point — exports apply/name/inject/Config
├── dsh/
│   └── adapter.js           the only DSH-specific file; HTTP route table + ChunkHandoff
├── host/
│   ├── voice-service.js     orchestrates record → transcribe → speak
│   ├── runtime-manager.js   detects/installs Whisper + Piper binaries
│   ├── model-manager.js     Whisper model install/remove/verify
│   ├── temp-sweep.js        startup cleanup of orphaned temp WAVs (>5 min old)
│   ├── config.js            Schemastery schema + defaults + per-field validation
│   └── diagnostics.js       Settings → Voice → Diagnostics report
├── stt/
│   ├── whisper.js           Const-me Whisper CLI invocation (argv-only)
│   └── languages.js         canonical Whisper language table
├── tts/
│   ├── piper.js             Piper CLI invocation (argv-only, stdin text)
│   ├── piper-worker.js      persistent single-voice Piper worker process
│   ├── queue.js             TTS job queue: pause/resume/stop + 3-chunk
│   │                        lookahead pipeline
│   └── text-cleaner.js      markdown/code/table stripping + word-based chunking
├── models/
│   ├── whisper-models.js    Whisper model registry (ggml-base.bin default)
│   ├── piper-catalogue.js   voices.json parser + cascading filters
│   └── downloader.js        temp-file → verify → atomic-move + DownloadQueue
├── client/                  browser bundle source (built → lib/client.js)
│   ├── index.jsx            registers the client module + UI slots
│   ├── MicButton.jsx        composer slot: conversation.input.left
│   ├── SpeakerButton.jsx    message slot: conversation.chat.assistant-actions
│   ├── SettingsCard.jsx     settings-page slot (Switch.svg toggles, quick-add filters, queue UI)
│   ├── AutoSpeaker.jsx      watches for new assistant replies, auto-speaks them
│   ├── Tooltip.jsx          DSH-styled portal tooltip
│   ├── player.js, encode-wav.js, api.js, extract-text.js   — browser-side helpers
│   ├── AnimatedIcon.jsx, icon-motion.js, icon-proximity.js — animated icons (play near pointer / when busy)
│   ├── icon-set.js (generated), icon-scope.js, icons/      — 28-icon pack, scoped at build time
│   ├── styles.js            — plugin stylesheet (icon gating, borderless mic, switch toggle)
│   ├── composer-microphone.js, assistant-speaker.js        — framework-agnostic state-machine logic
└── shared/
    ├── auto-send.js         mic auto-stop-on-silence + auto-send countdown
    ├── stt-reconcile.js     merges overlapping streamed STT windows into one transcript
    ├── text-filter.js       literal & regex text filters + default Whisper non-speech rules
    ├── wav-analyze.js       WAV RMS silence check + peak level normalization
    ├── voice-compat.js      pre-synthesis voice compatibility guard for Piper 2023.11.14-2
    ├── preview-sentences.js localized preview sentences per language code
    ├── validation.js, types.js, protocol.js, constants.js
```

**Client/host split**: DSH plugins ship two halves — host code that
`apply(ctx, config)` runs inside the Node process, and a separate browser
bundle (`dsh.client` in `package.json`, built with esbuild into
`lib/client.js`) that registers UI into named slots
(`@deepseek-ai/dsh-client-ui-slots`). Microphone capture and audio playback
both happen in the browser; the host handles STT/TTS compute, runtime/model
downloads, and file management.

**Transport**: the client and host communicate over HTTP routes under
`/dsh-osound/api/*` (23 endpoints) registered via `ctx.webServer`. TTS
audio uses a chunk-by-chunk long-poll hand-off (`GET /tts/chunk` /
`POST /tts/chunk-done`) with a liveness check and a 60-second watchdog so an
abandoned playback tab releases the queue cleanly.

## Development workflow

No compiler for host code — edit any file under `src/` other than
`src/client/`, restart DSH, done. For client changes:

```bash
npm run build:client   # regenerates icon-set.js and rebuilds lib/client.js
npm test               # runs all 266 unit and integration tests
```

## Known limitations

- Voices built for newer Piper phonemizer formats that use multi-codepoint
  phoneme keys (such as `bn_BD-google-medium`, `piper_version 1.5.0`) are
  detected from their `.onnx.json` and refused cleanly before synthesis with an
  explanatory message rather than crashing the bundled `2023.11.14-2` runtime.
- Streaming STT uses short-window incremental transcription with overlap
  reconciliation (`stt-reconcile.js`), not token-level streaming.

## Privacy

No cloud STT/TTS. No microphone-content logging by default (opt-in
`debugLogging` truncates logged transcripts). No recordings persisted
past transcription. Network is used only for runtime/model/voice
downloads and nothing else.

## Licenses

This plugin: MIT (`LICENSE`). Const-me Whisper and Piper: see their
respective repositories linked above. Piper voice models: license varies
per voice — the catalogue entry's `modelCardUrl` links to the specific
voice's model card.
