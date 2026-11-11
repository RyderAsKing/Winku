# Winku: spec v0.1

A small, always-available desktop assistant that lives as a pair of glowing eyes at the edge of the screen. Summon it with a key, type or talk, and it answers in text or voice. It can see the screen, run things, rewrite selected text in place, and keep one conversation going until you clear it. It is open source (MIT), has no login, and sends no telemetry.

Confirmed with the user on 2026-11-11, including the four points that were first written as interpretations: the memory snapshot rule (section 9), replace without preview (section 6), "Ask before running" off by default (section 7), and no catalog refresh from pi.dev (section 10).

## 1. Platforms and releases

- The first few releases are Windows only. Linux (KDE on Wayland first, then the others) and macOS come later.
- Builds for Windows, then Linux AppImage/deb, then macOS, come from GitHub Actions and are published to GitHub Releases. They are unsigned for now, and the README explains how to get past SmartScreen and Gatekeeper.
- Auto-update uses the Tauri updater, which verifies each update against our release signing key. The update downloads in the background and installs on the next restart or quit, with a small dot on the eyes until then. Settings: Auto-install (default), Notify only, Off.

## 2. Architecture

```
┌──────────── Tauri 2 shell (Rust) ────────────┐
│ global hotkeys (tap/hold), windows, tray,     │
│ selection capture + paste-back, screenshots,  │      ┌──── winku-engine (Bun binary) ───┐
│ UI Automation text, Credential Manager,       │◀────▶│ pi SDK, pinned version           │
│ sherpa-onnx STT, Supertonic/OS TTS, updater       │ JSON │ our ResourceLoader, our tools,    │
│                                               │ lines│ our sessions, compaction, caching │
│ webview: eyes + bar + transcript + settings   │      └──────────────────────────────────┘
└───────────────────────────────────────────────┘
```

- **Shell:** Rust and Tauri 2, with a thin web UI that uses SVG/CSS for the eyes and a small framework (Svelte or Solid) for the rest.
- **winku-engine:** our own process built on the pi SDK, compiled with Bun into a single binary. It starts with the app and stays running so summoning is instant. It is completely isolated from any pi install:
  - It uses a custom `ResourceLoader` and our own settings, so nothing is read from `~/.pi`, `.pi/`, `AGENTS.md`/`CLAUDE.md`, pi extensions or pi skills.
  - pi's agent and session folders live under `%APPDATA%\winku\engine\`.
  - `PI_OFFLINE`, `PI_TELEMETRY=0` and `PI_SKIP_VERSION_CHECK` are set, so pi.dev is never contacted.
  - The pi version is pinned in our lockfile and only changes when we upgrade it.
- **Memory budget:** 150 MB or less at idle on Windows, measured from the first build. If we miss it, the fallback is to draw the resting eyes natively and create the webview only when the bar is summoned, destroying it after a few idle minutes.

## 3. Surfaces

- **Resting eyes:** a dark pill, Small (92×56 px, the default), Medium (116×70) or Large (140×84) in Settings > Eyes. It is always on top, and clicks pass through everything except what Winku is drawing. You can drag it anywhere, it snaps to screen edges, and it remembers its position. It hides while a fullscreen app has focus. "Hide eyes" is a setting, and a tray icon appears only while the eyes are hidden.
- **Bar:** the pill stretches into the bar where it sits, toward the middle of the screen (leftward when the pill is on the right half). The eyes don't move, opening or closing, and the bubble follows the bar in. The bar is as tall as the pill and 400, 480 or 560 px wide by size. It shows a `23% ctx` meter and a small thinking-level label.
- **Reply bubble:** replies stream into a translucent rounded bubble just under the bar, or just over it when the pill sits low on the screen. It scrolls when the reply is long. When you talk (hold the key), run an action, or something needs your attention, the eyes stay as the pill and the bubble appears under them. It goes away a while after the reply has finished and been read out (longer for longer replies, never while the pointer is over it). Clicking it opens the bar.
- **Transcript:** `Ctrl+J` shows the whole conversation in a taller bubble under the bar. It renders markdown and code blocks with copy, shows tool calls as collapsed rows, and shows compaction as a collapsible "Earlier conversation summarized" row.
- **Right-click menu on the eyes:** Settings, History, Ask before running, Hide eyes, Pause listening, Quit.
- **Settings:** an ordinary window of about 860×600 px: a list of sections on the left (Model, Conversation, Tools, Speech, Memory and voice, Actions, Keys, Eyes, App) and the chosen section on the right, as grouped rows with the setting on the left and its control on the right. On-off settings are switches. A section that needs attention (a key conflict, no model yet) is marked in the list. A narrow window moves the list to a strip along the top.
- **First run:** there is no wizard. On the first summon, the bar shows an inline "Connect a model" form: pick a provider, enter a key and a model, run a test, and you're done. Voice models download the first time you hold the talk key, with progress shown on the eyes.

## 4. Eyes

The design language comes from the user's research page (https://always-on-eyes-ui-ux-for-a-tiny-desktop-t22o.pages.grok.bot/): glossy rounded-square eyes with a soft glow on a dark face. The face is always dark (`#07080C`–`#181B22`) whatever the OS theme is. The glow is something the user asked for.

| State | Look | Trigger |
|---|---|---|
| Idle | resting tint, occasional slow blink and glance away | nothing in progress |
| Listening | slightly larger, teal `#4CFFE3`, gentle pulse | talk key held |
| Thinking | pair tilts, gaze up-right, amber `#FFD56A` | waiting on the model, compaction |
| Speaking | lavender `#C9B8FF`, soft squash-and-bounce | streaming or TTS |
| Happy `^^` | closed arcs, faint blush | mood tag, or about 2 s after a reply finishes |
| Hearts | heart eyes, blush, kept rare | mood tag, or when you say thanks |
| Error | inward slant, coral `#FF8B82`, tiny tear | network, auth or model failure |
| Cleared | wipe blink, then wide and bright | clear context |
| Sleeping | thin crescents, slow breathing | idle for a long time |
| Noted | small blink | a memory was saved |

- **Mood:** the model may end a reply with a hidden tag such as `<mood:happy>`. The app strips the tag and the eyes react. Simple rules are the fallback when a model ignores the tag.
- **Context fullness:** the lids lower gradually as context fills, up to about 30% closed at the limit. Compaction plays a small yawn. Clear plays the wipe, then wide, refreshed eyes.
- **Thinking level sets the resting tint:** off = pale mint, low = soft cyan, medium = cyan `#5EF6F0`, high = deep sky blue, max = indigo. State colours take over during activity.
- **Motion budget:** the glow is drawn once as a static layer, and only movement and opacity are animated. Blinks are one-off animations of about 300 ms on a timer, not endless loops. All animation freezes when the bar is hidden or the eyes are asleep. The OS "reduce motion" setting switches to still frames. The goal is close to 0% CPU at idle.
- The eyes never start a conversation or speak unprompted. Error states are the only exception.
- Known bugs in the research prototype, not to copy: the "cleared" state renders inverted (white pill, black eyes), and the eyelids show as black caps in light mode.

## 5. Keymap

Everything is reachable with the left hand and everything is rebindable (the user has no Caps Lock key). Settings warns about conflicts and detects layouts where `Ctrl+Alt` acts as AltGr, suggesting `Ctrl+Shift` instead. An optional leader key (e.g. F13 on a programmable keyboard) can replace `Ctrl+Alt`.

Holding the prefix (`Ctrl+Alt` or the leader key) alone for about 450 ms shows small hints next to the eyes saying what each key does; they go away as soon as another key goes down or the prefix is released, and never show over a fullscreen app.

| Keys | Does |
|---|---|
| tap `Ctrl+Alt+Space` | open or hide the bar |
| hold `Ctrl+Alt+Space` | talk; release to send; also interrupts speech |
| `Ctrl+Alt` + `1`–`5` | action slots 1–5 on the selected text |
| `Ctrl+Alt+Q` | ask about the selection (opens the bar with it as a chip) |
| `Ctrl+Alt+S` | attach a screenshot of the current window |
| `Ctrl+Alt+X` | clear context (wipe + 5 s Undo toast) |
| `Ctrl+Alt+T` | cycle Main's thinking level |
| `Esc` | first press stops the reply, tool or speech; second hides the bar |
| `Ctrl+J` | expand or collapse the transcript |

## 6. Actions

An action is a config entry with a name, a prompt, a key slot, an output mode and a "use thread context" toggle.

- **Output modes:**
  - **replace:** paste the result over the selection straight away, with no preview. The target app's own `Ctrl+Z` undoes it.
  - **show:** the result appears in the bar.
  - **agent:** the action runs in the main thread with tools.
- Replace and show actions are one-off calls on the Quick actions model. They are not added to the thread, but they are recorded in History.
- Defaults: 1 Rewrite (replace), 2 Fix grammar (replace), 3 Shorter (replace), 4 Explain (show), 5 Do it (agent).
- Rewriting actions apply your voice profile.
- Selection capture tries UI Automation first and falls back to a simulated copy that saves and restores the clipboard.

## 7. Agent, tools and screen

- **Tools:** run commands, read and write files, open apps and URLs, web search, `look_at_screen`, and the memory tools.
- **Permissions:** everything is allowed by default and `Esc` stops it immediately. "Ask before running" is an opt-in switch in the right-click menu, off by default. When it is on, a check in front of each tool call shows Allow once / Always allow this command / Deny for anything that writes, deletes, runs or sends input.
- **Screen awareness:** every message you send carries a small "now" line with the active app, the window title and the selection. It goes at the end of the message so caching is unaffected. `look_at_screen` returns a downscaled screenshot of the active window plus text from UI Automation. If the Main model doesn't support images, it returns only the text. Screenshots are dropped from the thread when it is compacted.

## 8. Context, caching and history

- There is one thread, it survives restarts, and it lasts until you clear it.
- **Request layout:** the system prompt comes first and stays the same for the whole session. It holds the instructions, tools, About me, the voice profiles and the `MEMORY.md` index as it was when the session started. After that comes the conversation, which is only ever appended to. This keeps provider prompt caching working.
- **Compaction:** pi auto-compacts at its default threshold, adjustable in Settings. The meter and the eyelids both show how full the context is.
- **Clear:** archives the session and starts a new one. Memory, About me and voice profiles survive.
- **History:** right-click > History lets you read and search archived sessions, and "Restore as current" brings one back after archiving the current session first.

## 9. Memory and voice

All of this is plain markdown under `%APPDATA%\winku\`, so you can edit it in any editor.

```
%APPDATA%\winku\
  settings.json
  about-me.md            yours; the assistant only reads it
  voice\casual.md        your voice profiles (rules + samples), chosen by active app
  voice\work.md
  memory\MEMORY.md       index, about 150 lines max, always in the system prompt
  memory\<topic>.md      details, read only when the index points to them
  engine\                pi agent dir + sessions (internal)
  models\                downloaded STT/TTS models
```

- **Writing memory:** the assistant writes memory on its own and when you ask it to "remember…". Each save shows a "Saved to memory: …" row with Undo, and the eyes do the "noted" blink.
- **Voice profiles:** the assistant can only propose changes to a voice profile, which you Accept or Dismiss. "Learn from my edits" comes after v1.
- **Caching:** new memory reaches the system prompt only after a clear or a compaction. Until then the transcript row is how the model knows about it.
- **Forget everything:** a separate Settings button that wipes `memory\`, after a confirmation.
- **Its voice:** how the assistant talks to you is a separate setting from your voice.

## 10. Models

- **Provider:** one per install. Pick from pi's built-in list or "Custom OpenAI-compatible" (base URL, with presets for Ollama and LM Studio).
- **Key:** stored in Windows Credential Manager and passed to winku-engine when it starts. It is never written to disk by us or by pi.
- **Main and Quick actions models:** searchable dropdowns built from pi's bundled catalog or the endpoint's `/v1/models` list, and you can always type a model ID. Quick actions follows Main until you change it.
- **Catalog:** pi's bundled catalog is never refreshed from pi.dev. New models arrive when we upgrade pi.
- **Image support and context window:** read from the catalog. For custom endpoints, "Test connection" probes image support with a tiny test image, and the context window is an editable field.
- **Thinking level:** set per role, with Main at medium and Quick actions off by default.
- **Sign-in:** API keys only in v1. Subscription sign-in comes later.

## 11. Voice

- **Engine:** sherpa-onnx (Apache-2.0) running inside the Rust shell. It loads on first use and unloads after about 3 idle minutes.
- **Speech-to-text:** Moonshine base or Whisper base.en by default. Parakeet is an optional download.
- **Text-to-speech:** Supertonic (MIT, about 85 MB) by default, an offline neural voice that downloads on first use; ten voices to choose from. The voices built into the OS (Windows OneCore) read while it downloads and stay a Settings option. Piper isn't used because it is GPL. Kokoro was dropped: with sherpa-onnx 2.x it skips numbers, symbols and plural forms.
- **When it speaks:** replies mirror how you asked, so if you spoke it answers with voice and text, and if you typed it answers with text only. A setting can force always voice or always text. Holding the talk key interrupts speech.
- **What it says and what it shows:** a spoken reply has two parts. What it says is written for listening: plain sentences, numbers and abbreviations said the way a person would, and no paths, code, commands, links or tables (it says they are on screen instead). What it shows is the usual written reply, exact details included. The voice starts as soon as the said part is ready, before the written part has finished. When the two would be the same, it only writes one, and that is shown too.
- **How much it says** (Settings): "A sentence or two", "Enough to follow without looking" (the default) or "Everything it writes", reworded for listening.

## 12. Not in v1

- Automatic "learn from my edits" for voice profiles.
- Subscription sign-in for model providers.
- Linux and macOS builds.
- A notch pill on macOS.
- Code signing.

## 13. Build order

1. **Spike:**
   - Confirm the pi SDK compiles into a working single Bun binary on Windows.
   - Get the Tauri shell starting winku-engine and streaming one reply.
   - Measure idle memory.
2. **Core:**
   - Eyes pill and bar, with summon, streaming, transcript and `Esc`.
   - Settings with provider and model, and the key in Credential Manager.
   - A persistent thread with clear, Undo and History.
   - The context meter.
3. **Eyes:** all states, mood tags, sleepy lids, thinking-level tints and the motion budget.
4. **Actions:** selection capture and paste-back, the five defaults, and the action editor.
5. **Memory and voice profiles:** the index and topic files, About me, voice profiles, and the caching rules.
6. **Agent tools:** tools, "ask before running", the "now" line and `look_at_screen`.
7. **Voice:** sherpa-onnx speech-to-text with hold-to-talk, then OS text-to-speech and the mirror mode.
8. **Ship:** fullscreen hiding, launch at login, the updater, CI releases and the README.
