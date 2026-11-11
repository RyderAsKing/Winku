# Winku architecture

How the pieces fit and the contracts between them. [SPEC.md](SPEC.md) says what Winku does; this says how. When the two disagree, the spec wins and this file gets fixed.

## Processes and ownership

```
app/ui (Svelte webview)  ──invoke/events──▶  app/src-tauri (Rust shell)  ──JSON lines──▶  engine (Bun binary, pi SDK)
```

| Piece | Owns |
|---|---|
| **UI** (`app/ui`) | The interaction state machine: what the bar shows, eye states, toasts, Undo windows, the Connect form, Settings and History screens. Never touches the disk or the network. |
| **Shell** (`app/src-tauri`) | OS integration: windows and their geometry, global hotkeys, tray, native context menu, `settings.json`, the API key in Credential Manager, selection capture and paste-back, foreground app and window title, screenshots, UI Automation text, speech (sherpa-onnx, OS TTS), updater, launch at login. Starts and stops the engine. |
| **Engine** (`engine`) | Everything model-related: pi sessions, the thread and its history, compaction, the frozen system prompt, actions, tools, memory files, voice profiles. Reads `about-me.md`, `voice\`, `memory\`; writes `memory\`, `voice\` (only after Accept) and `engine\`. |

The engine never reads `settings.json`; the shell sends what it needs in `configure`. The UI never sees the API key; the shell reads it from Credential Manager and sends it in `configure`.

## Engine protocol

Defined in [`engine/src/protocol.ts`](../engine/src/protocol.ts), which is the source of truth. Summary:

- Shell → engine: **Commands** `{type, id?, …}`. With an `id`, the engine answers with a **Result** `{type:"result", id, ok, data|error}`.
- Engine → shell: **Events** (`text_delta`, `reply_end`, `context`, `thread_changed`, …), fire-and-forget.
- Engine → shell: **Requests** `{type:"request", id, method, params}` for things only the shell can do (`screen_capture`) or only the user can decide (`permission`). The shell answers with a **Response**.
- Prompt ids and action ids are chosen by the sender and echoed on every event of that reply.
- `reply_end` is sent on `agent_settled`, not `agent_end`, so retries and compaction finish first.
- The engine strips `<mood:…>` tags from streamed text and reports the mood on `reply_end`.
- Errors carry an `errorKind` (`auth`, `network`, `model`, `config`, `engine`) so the eyes can pick the error state and the UI can offer the right fix.

## Shell ↔ UI contract

### Commands (`invoke`)

| Command | Args → returns | Step |
|---|---|---|
| `engine_send` | `{ message: Command }` → `()` | 2 |
| `engine_call` | `{ message: Command }` (shell assigns `id`) → Result `data`, or rejects with the error | 2 |
| `engine_respond` | `{ response: Response }` → `()` (answers a `permission` Request) | 6 |
| `settings_get` | `()` → `Settings` | 2 |
| `settings_set` | `{ settings: Settings }` → `Settings`. Saves, re-registers hotkeys, sends `configure` if anything the engine uses changed. | 2 |
| `secret_set` | `{ apiKey: string }` → `()` | 2 |
| `secret_clear` | `()` → `()` | 2 |
| `secret_present` | `()` → `boolean` | 2 |
| `window_mode` | `{ mode: "pill" \| "bar" \| "transcript" }` → `()` | 2 |
| `window_bar_height` | `{ height: number }` → `()` (whole bar in logical px, input row plus reply; clamped to 72–432) | 2 |
| `open_window` | `{ name: "settings" \| "history" }` → `()` | 2 |
| `context_menu` | `()` → `()` (native menu at the cursor) | 2 |
| `open_external` | `{ url }` → `()`; http(s) only, opens the default browser | 2 |
| `hotkeys_status` | `()` → `{ failed: { name, binding, error }[] }`: bindings that didn't register | 2 |
| `hotkeys_altgr` | `()` → `{ altGr: boolean \| null, keys: string[], conflicts: string[], suggestion }`: whether `Ctrl+Alt` is AltGr in the current layout and which bindings it breaks | 2 |
| `now_line` | `()` → `NowLine` captured when the bar was summoned | 6 |
| `screenshot` | `()` → `ImageAttachment` of the window that was active before the bar | 6 |
| `speak` / `stop_speaking` | `{ text }` / `()` | 7 |

### Events (`listen`)

| Event | Payload |
|---|---|
| `engine` | Every engine Event, plus `permission` Requests |
| `ui` | `{ kind: "summon" }`, `{ kind: "hide" }`, `{ kind: "toggle_transcript" }`, `{ kind: "ask_selection", text }`, `{ kind: "attach_screenshot", image }`, `{ kind: "clear" }`, `{ kind: "cycle_thinking" }`, `{ kind: "action_started", slot, name, output }`, `{ kind: "talk_start" }`, `{ kind: "talk_level", level }`, `{ kind: "talk_end", text }`, `{ kind: "menu", item }`, `{ kind: "update_ready" }` |
| `settings_changed` | `Settings`, to every window after any change (Settings window, menu, tray, a saved pill position) |
| `hotkeys_status` | Same payload as the `hotkeys_status` command, after every (re-)registration |
| `download_progress` | `{ what: "stt" \| "tts", fraction }` (voice models, step 7) |

Global hotkeys are handled in the shell, which does the OS-side work (capture the selection before the bar takes focus, take the screenshot) and then emits a `ui` event. The UI does the rest. `Esc` and `Ctrl+J` are ordinary in-window keys.

Actions (`Ctrl+Alt+1…5`) run in the shell: it captures the selection, sends `run_action`, and on `action_end` either pastes (replace) or summons the bar to show the result (show). Agent actions go into the thread like a prompt.

## Windows

- **Main window** (label `main`): transparent, undecorated, always on top, skipped in the taskbar, no shadow. One webview that morphs, so only one renderer stays alive (the memory budget is 150 MB and WebView2 already takes about 62 MB).
  - `pill`: 140×84 at the remembered position (default: right edge, a third of the way down the primary monitor). Doesn't take focus. Draggable; snaps to the nearest screen edge within 24 px on release; the position is saved per monitor setup.
  - `bar`: 560 wide (640 max), 72 tall plus the streamed reply (up to 360), near the top centre of the monitor under the cursor (12% down). Takes focus.
  - `transcript`: 420×560 (480 wide when the monitor is 2560 logical px or wider), anchored where the bar was.
  - Hiding the bar returns to `pill` at its remembered position.
- **Settings** (`settings`) and **History** (`history`): ordinary decorated windows, created on demand and destroyed on close.
- Pages are a multi-page Vite build: `index.html` (main), `settings.html`, `history.html`.

## Hotkeys

- Registered with `tauri-plugin-global-shortcut`, which reports Pressed and Released.
- Tap vs hold on the summon key: released within 250 ms = tap (toggle the bar); held longer = talk (step 7).
- Bindings come from `settings.hotkeys`; an empty string means unbound. If a leader key is set, it replaces `Ctrl+Alt` in every binding. A leader made of modifiers (`Ctrl+Shift`) is substituted directly. A leader that is an ordinary key (`F13`) is a held chord: the shell registers the leader, and registers the rest of each binding (`Space`, `1`, …) only while the leader is down.
- Failures are reported by the `hotkeys_status` command and event. Settings warns when a binding fails to register (taken by another app) and when the keyboard layout has AltGr (`Ctrl+Alt` types characters), suggesting `Ctrl+Shift`.

## `settings.json`

Owned by the shell (`app/src-tauri/src/settings.rs`); the TypeScript mirror is `app/ui/src/lib/settings.ts`. Unknown fields are kept; missing fields take defaults.

```jsonc
{
  "version": 1,
  "provider": null,                       // ProviderConfig from protocol.ts, null until connected
  "main": null,                           // { "id": "claude-sonnet-4-5", "thinking": "medium" }
  "quick": null,                          // null = follow main with thinking "off"
  "compactionReserveTokens": null,        // null = pi's default (16384)
  "askBeforeRunning": false,
  "alwaysAllow": [],                      // allowKey values
  "assistantStyle": "",                   // "Its voice": how Winku talks to you
  "voiceProfiles": { "default": "casual", "byApp": { "outlook.exe": "work" } },
  "actions": [                            // slots 1–5, in order
    { "name": "Rewrite",     "prompt": "…", "output": "replace", "useThreadContext": false, "useVoice": true },
    { "name": "Fix grammar", "prompt": "…", "output": "replace", "useThreadContext": false, "useVoice": false },
    { "name": "Shorter",     "prompt": "…", "output": "replace", "useThreadContext": false, "useVoice": true },
    { "name": "Explain",     "prompt": "…", "output": "show",    "useThreadContext": false, "useVoice": false },
    { "name": "Do it",       "prompt": "…", "output": "agent",   "useThreadContext": true,  "useVoice": false }
  ],
  "hotkeys": {
    "summon": "Ctrl+Alt+Space",
    "actions": ["Ctrl+Alt+1", "Ctrl+Alt+2", "Ctrl+Alt+3", "Ctrl+Alt+4", "Ctrl+Alt+5"],
    "askSelection": "Ctrl+Alt+Q",
    "screenshot": "Ctrl+Alt+S",
    "clear": "Ctrl+Alt+X",
    "cycleThinking": "Ctrl+Alt+T"
  },
  "leaderKey": null,                      // e.g. "F13"; replaces Ctrl+Alt in every binding
  "eyes": { "hidden": false, "positions": {} },   // positions keyed by monitor-layout signature
  "voice": { "stt": "moonshine-base", "tts": "os", "osVoice": null, "reply": "mirror", "listeningPaused": false },
  "updates": "auto",                      // "auto" | "notify" | "off"
  "launchAtLogin": true
}
```

The API key lives in Credential Manager under service `winku`, account `api-key` (the `keyring` crate; Secret Service on Linux, Keychain on macOS).

## Data folder

`%APPDATA%\winku\` on Windows, `$XDG_DATA_HOME/winku` on Linux (Tauri's `data_dir()` + `winku`). Layout as in SPEC.md §9, plus:

```
engine\sessions\*.jsonl     pi session files, one per thread (current and archived)
engine\current.json         { "sessionFile": "…" }: which thread is current
engine\actions.jsonl        one line per replace/show action, for History
```

## Module layout

```
engine/src/
  main.ts        stdin loop and dispatch
  protocol.ts    the contract
  io.ts          stdout/stdin JSON-lines helpers
  isolate.ts     pi isolation env, console → stderr
  engine.ts      ties runtime + thread + the live AgentSession; rebuilds it on configure/clear/restore
  runtime.ts     ModelRuntime, catalog/custom providers, keys, model info, test connection
  thread.ts      current thread, clear/undo, history list/search/read/restore, transcript items
  reply.ts       one prompt → thinking/text/tool/context/reply_end events
  mood.ts        streaming <mood:…> stripper (pure)
  nowline.ts     <now …> line appended to the user message, and its parser for transcripts
  faux.ts        scripted winku-faux provider for tests (configure accepts a test-only `faux` field)
  prompt.ts      frozen system prompt (instructions, about-me, voice profiles, MEMORY.md snapshot)
  actions.ts     one-off actions on the Quick model                       (step 4)
  memory.ts      MEMORY.md index + topic files, save/undo/forget           (step 5)
  voice.ts       voice profiles, proposals                                 (step 5)
  tools/         look_at_screen, open, web, memory tools, permission gate  (step 6)

app/src-tauri/src/
  lib.rs         builder, plugins, command registration
  engine.rs      sidecar, Result correlation for engine_call, Request routing
  settings.rs    schema, defaults, load/save
  secrets.rs     keyring
  hotkeys.rs     registration, tap/hold, leader key, AltGr check
  window.rs      modes, geometry, cursor monitor, snapping, saved positions
  menu.rs        context menu, tray (only while the eyes are hidden)
  commands.rs    #[tauri::command] functions
  platform/      foreground app, selection, paste, screenshot, UI Automation (windows.rs + fallback.rs)
  voice/         sherpa-onnx STT, OS/Kokoro TTS                             (step 7)

app/ui/src/
  main/          the main window: Eyes, Bar, Transcript, Connect form, toasts
  settings/      Settings window
  history/       History window
  lib/           settings.ts, engine.ts (typed invoke/listen wrappers), shared components
```

## Testing and CI

- Engine: `bun test` against pi-ai's scripted test model (`winku-faux`), no keys or network. Pure modules (mood stripper, prompt builder, memory index) get unit tests. Everything also runs against the compiled binary in CI.
- Shell: `cargo test` for pure logic (settings defaults and migration, snapping, tap/hold timing, hotkey parsing). Platform code is behind traits so the logic is testable on Linux.
- UI: `svelte-check` and a Vite build.
- Screenshots: `cd app && bun run ui:dev` (http://127.0.0.1:5173), then `bun run screenshots [before|after] [case …]`. Output goes to `app/.screenshots/<label>/`. Outside Tauri the UI runs on the browser mock shell (`app/ui/src/lib/mock.ts`), with canned replies, transcript and history, so no keys or engine are needed. Cases: `pill`, `pill-full-context`, `bar`, `reply`, `error`, `cleared`, `chips`, `transcript`, `connect`, `settings`, `settings-keys-warnings`, `history`. Sizes are a normal and a high-DPI desktop; Winku has no mobile layout.
- CI: the Windows job builds everything, runs all tests, runs the smoke test and records idle memory. A Linux job runs the same checks faster.

## Decisions not spelled out in the spec

- **One morphing main window** rather than separate pill and bar windows: one renderer instead of two keeps memory down. Settings and History are created on demand.
- **The UI drives interaction; the shell handles the OS.** The shell does the time-critical parts of a hotkey (grab the selection before focus moves) and then hands off to the UI through a `ui` event.
- **Frozen system prompt lives in the thread.** pi records the prompt as a system message in the session file; when a thread is reopened (restart, Undo, Restore) the engine reuses that preamble instead of rebuilding it, so a settings change only reaches the prompt after a clear or a compaction.
- **Thread pointer file** (`engine\current.json`) instead of "most recent session file", so Restore survives a restart even before the restored thread gets a new message.
- **Tap/hold threshold** of 250 ms on the summon key.
