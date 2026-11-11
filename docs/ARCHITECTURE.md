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
| `secret_set` | `{ apiKey, account? }` → `()`. `account` is `"api-key"` (default, the provider key) or `"search-api-key"` (Brave Search). Stored in Credential Manager, then `configure` is re-sent. | 2, 6 |
| `secret_clear` | `{ account? }` → `()` | 2, 6 |
| `secret_present` | `{ account? }` → `boolean` | 2, 6 |
| `window_mode` | `{ mode: "pill" \| "bar" \| "transcript" }` → `()` | 2 |
| `window_bar_height` | `{ height: number }` → `()` (whole bar in logical px, input row plus reply; clamped to 72–432) | 2 |
| `open_window` | `{ name: "settings" \| "history" }` → `()` | 2 |
| `context_menu` | `()` → `()` (native menu at the cursor) | 2 |
| `open_external` | `{ url }` → `()`; http(s) only, opens the default browser | 2 |
| `hotkeys_status` | `()` → `{ failed: { name, binding, error }[] }`: bindings that didn't register | 2 |
| `hotkeys_altgr` | `()` → `{ altGr: boolean \| null, keys: string[], conflicts: string[], suggestion }`: whether `Ctrl+Alt` is AltGr in the current layout and which bindings it breaks | 2 |
| `open_data_path` | `{ what: "about_me" \| "memory" \| "voice" }` → `()`: opens the file or folder (see "Memory and voice profiles") | 5 |
| `now_line` | `()` → `NowLine` captured when the bar was summoned | 6 |
| `screenshot` | `()` → `ImageAttachment` of the window that was active before the bar | 6 |
| `speak` / `stop_speaking` | `{ text }` / `()`. `speak` replaces anything already playing, with the voice from `settings.voice.tts` (and `osVoice`). The UI strips markdown first. | 7 |
| `voice_os_voices` | `()` → `{ id, name, language }[]`: the OS voices (Windows OneCore), `[]` where there are none | 7 |
| `voice_models` | `()` → `{ id, kind: "stt" \| "tts", name, sizeMb, installed, downloading }[]` | 7 |
| `update_status` | `()` → `UpdateStatus`: `{ state: "idle" \| "checking" \| "available" \| "downloading" \| "ready" \| "error", version?, notes?, error? }` | 8 |
| `update_check` | `()` → `UpdateStatus` after checking now (Settings "Check now"); in `auto` mode it also starts the download | 8 |
| `update_restart` | `()` → `()`: download if needed, install and relaunch (bar link, menu item) | 8 |
| `voice_model_download` / `voice_model_remove` | `{ id }` → `()`. Download returns at once; progress comes as `download_progress` | 7 |

### Events (`listen`)

| Event | Payload |
|---|---|
| `engine` | Every engine Event, plus `permission` Requests |
| `ui` | `{ kind: "summon" }`, `{ kind: "hide" }`, `{ kind: "toggle_transcript" }`, `{ kind: "ask_selection", text }`, `{ kind: "attach_screenshot", image }`, `{ kind: "clear" }`, `{ kind: "cycle_thinking" }`, `{ kind: "action_started", id, slot, name, output }`, `{ kind: "action_error", id?, slot, name, message }`, `{ kind: "talk_start" }`, `{ kind: "talk_level", level }` (0–1, at most 15 a second), `{ kind: "talk_end", text }` (`""` when nothing was heard), `{ kind: "speech", playing }` (text-to-speech started or finished), `{ kind: "voice_error", message }`, `{ kind: "menu", item }`, `{ kind: "update_ready", version }` (an update is downloaded, or available in `notify` mode: the eyes show a small dot) |
| `settings_changed` | `Settings`, to every window after any change (Settings window, menu, tray, a saved pill position) |
| `hotkeys_status` | Same payload as the `hotkeys_status` command, after every (re-)registration |
| `update_status` | `UpdateStatus`, whenever it changes |
| `download_progress` | `{ what: "stt" \| "tts", model, fraction }` while a voice model downloads; `fraction: 1` when it is installed. A failure sends `ui` `voice_error` and `{ ..., fraction: -1 }`. |

Global hotkeys are handled in the shell, which does the OS-side work (capture the selection before the bar takes focus, take the screenshot) and then emits a `ui` event. The UI does the rest. `Esc` and `Ctrl+J` are ordinary in-window keys.

Actions (`Ctrl+Alt+1…5`, SPEC §6) start in the shell:

1. Remember the foreground window, wait (up to 600 ms) for the hotkey's modifiers to be released, then capture the selection: UI Automation's TextPattern first, then a simulated `Ctrl+C` that saves every clipboard format first and restores them after.
2. Nothing selected: emit `ui` `action_error` ("Select some text first"). Otherwise send `run_action` with a fresh id (`action-<n>`) and emit `ui` `action_started` with that id.
3. replace: on `action_end` for that id (not aborted, non-empty), bring the remembered window back to the front, put the text on the clipboard, send `Ctrl+V`, and restore the previous clipboard about 500 ms later. The target app's own `Ctrl+Z` undoes the paste. If pasting fails, emit `action_error` and the UI shows the result in the bar instead.
4. show and agent: the UI opens the bar with the reply (`action_delta`/`action_end` for show; the usual prompt events for agent).

`Ctrl+Alt+Q` (ask about the selection) uses the same capture and emits `ask_selection`. The bar is not opened for replace actions; the eyes on the pill show thinking, then happy or error.

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
engine\memory-undo.jsonl    one line per memory save (files before/after) and per undo, so Undo works after a restart
```

## Agent tools

SPEC §7. Registered by the engine for the main thread (and agent actions); one-off actions get no tools.

| Tool | Does | Asks first when "Ask before running" is on |
|---|---|---|
| `read`, `ls`, `find`, `grep` | pi's file tools; `find` uses a built-in glob instead of `fd`, and `grep` is only offered when ripgrep (`rg`) is on PATH (the engine never downloads either) | no |
| `write`, `edit` | pi's file tools | yes; allowKey `write:<path>` / `edit:<path>` |
| `powershell` | pi's PowerShell tool (Windows) | yes; allowKey `powershell:<first command word>` |
| `bash` | pi's bash tool, only when a bash is found (Git Bash on Windows) | yes; allowKey `bash:<first command word>` |
| `open` | `{ target }`: an http(s) URL, a file or folder path, or an app name, opened the way Explorer would | yes; allowKey `open:<target>` |
| `web_fetch` | `{ url }`: http(s) only, never into the local network, returns readable text, capped | no |
| `web_search` | `{ query }`: Brave Search API, only when a search key is set | no |
| `look_at_screen` | asks the shell for a `screen_capture`; image only if the Main model takes images | no |
| `memory_save`, `memory_read`, `voice_propose` | see "Memory and voice profiles" | no |

- Tools run in the user's home folder (not the data folder). pi's session keeps the data folder as its cwd (isolation); each tool call sees the home folder as its cwd instead.
- **`open`** only opens http(s) URLs (every other scheme, such as `file:`, `javascript:` or `ms-settings:`, is refused), paths that exist (UNC and device paths are refused), and app names made of letters, digits, spaces and `. _ - ( ) +`. On Windows a URL goes to `rundll32 url.dll,FileProtocolHandler`, a path to `explorer.exe`, an app name to `cmd /d /c start "" "<name>"`; macOS uses `open` (`open -a` for apps), Linux `xdg-open` (an app name is started directly). Nothing goes through a shell except the restricted app name.
- **`web_fetch`** resolves the host first and refuses loopback, private, link-local, CGNAT, multicast and reserved addresses (v4 and v6, including v4-mapped), `localhost`, `*.local` and `*.internal`. Redirects (at most 5) are followed by hand and each hop is checked again. 15 s timeout, 2 MB download, 20,000 characters of text; HTML loses scripts, styles, navigation and forms, and keeps headings, list items and links (`text (url)`) as text. Binary content types are refused.
- **`web_search`** calls the Brave Search API (`X-Subscription-Token`) and returns title, URL and snippet for the top 8 results.
- **`look_at_screen`** sends `screen_capture` with `includeImage` = the Main model takes images, waits up to 10 s, and returns the app, window title and UI Automation text, plus the screenshot as image content when there is one.
- **Ask before running** (off by default; right-click menu and Settings): before a gated tool runs, the engine sends a `permission` Request with `{ replyId, tool, summary, allowKey }` unless `allowKey` is in `alwaysAllow` (compared case-insensitively). The bar shows Allow once / Always allow this command / Deny. "Always" also adds the key to `settings.alwaysAllow` (the engine adds it to its in-memory list at once). Deny gives the model a tool result saying the user declined. `Esc` (abort) denies any pending request; so does an error Response or no answer within 30 minutes. Summaries: `Run: <command>`, `Write <absolute path>`, `Edit <absolute path>`, `Open <target>`; `write`/`edit` keys use the absolute path.
- **"Always allow" never covers a compound command.** A `powershell`/`bash` command that chains, pipes, redirects, substitutes or spans lines (`;`, `&`, `|`, `<`, `>`, `` ` ``, `$(`, a newline) is always asked about, even when its first word is in `alwaysAllow`; otherwise `ls; rm -rf ~` would ride on `bash:ls`.
- **Settings changes keep the reply running.** A `configure` that only changes `askBeforeRunning`, `alwaysAllow` or `searchApiKey` updates them in place: no session rebuild, no abort. Adding or removing the search key switches `web_search` on or off once the current reply settles.
- **Now line:** when the bar is summoned (hotkey or pill click), the shell notes the foreground app (process name), its window title and its selection (UI Automation only, never a simulated copy). `now_line` returns that snapshot; the UI sends it with each prompt and the engine appends it to the user message.
- **Screenshot hotkey** (`Ctrl+Alt+S`): the shell captures the foreground window (downscaled like `screen_capture`) and emits `ui` `attach_screenshot`; the UI shows it as a chip and sends it with the next prompt.
- **Compaction drops screenshots:** images in the kept part of the thread are replaced by "[screenshot removed]" when the thread is compacted. This happens in what is sent to the model (a context transform on the session's agent): the session file keeps the images, so the transcript still counts them, and images sent after the compaction are untouched.
- **Tool events** carry a short summary without the tool name (the UI shows `name: summary`): the command's first line for shells, the file name for `read`/`write`/`edit`, the URL, query or target for the web tools and `open`.

## Memory and voice profiles

SPEC §9. All plain markdown, editable in any editor; the engine re-reads the files when it builds a system prompt, so outside edits are picked up at the next clear or compaction.

- **Starter files.** On `configure`, if missing, the engine creates `about-me.md` (a short commented template), `voice\casual.md` and `voice\work.md` (a few starter rules each) and an empty `memory\MEMORY.md`. It never overwrites existing files.
- **About me** is read-only for the assistant: no tool writes it.
- **Memory tools** (engine `customTools`):
  - `memory_save { title, topic, content }`: appends a dated section to `memory\<topic>.md` (topic is a slug; created if new; names with `/`, `\` or `..`, and `memory` itself, are rejected) and adds or updates one index line in `MEMORY.md`: `- [<title>](<topic>.md): <one-line hook>`. The index is kept to about 150 lines (oldest lines drop off; their topic files stay). Emits `memory_saved { id, saveId, title }`; the eyes do the "noted" blink and the reply shows "Saved to memory: … Undo".
  - `memory_read { topic }`: returns `memory\<topic>.md`, for when the index points to it.
  - Undo (`memory_undo`) restores `MEMORY.md` and the topic file to their contents before that save (if they haven't changed since; otherwise it removes just that section and line). It works for saves in the current thread, across restarts (`engine\memory-undo.jsonl`); a save from another thread is refused. When it falls back to removing just that save and the topic file ends up empty, the file and its index line go.
  - The transcript shows each save as a `memory_saved` row, with `undone` set after Undo. A failed save (bad topic) stays an ordinary `tool` row.
- **Caching rule.** The system prompt (instructions, About me, every voice profile, the `MEMORY.md` index) is a snapshot taken when the thread starts and again after a compaction. New memory reaches it only then; until then the `memory_saved` tool result in the conversation is how the model knows. A threshold compaction happens inside a run, and pi can't reload mid-run, so the new snapshot is applied once the run settles (from the next prompt). `about-me.md` that is only the starter comment is left out.
- **Voice profiles** live in `voice\<name>.md`. `settings.voiceProfiles.byApp` maps a process name (`outlook.exe`) to a profile, else `default`. The shell picks the profile from the foreground app when an action starts and sends its name with `run_action`; rewriting actions (`useVoice`) get its contents. The assistant can only propose changes: `voice_propose { profile, content, reason }` emits `voice_proposal`, the bar shows Accept / Dismiss, and `voice_proposal_decision` writes the file only on Accept. Pending proposals are dropped on clear.
- **Forget everything** (Settings, after a confirmation in the UI): `memory_forget_all` deletes everything in `memory\` and recreates an empty `MEMORY.md`. About me and voice profiles stay.
- **Opening the files.** The shell's `open_data_path { what: "about_me" | "memory" | "voice" }` opens `about-me.md` in the default editor, or the `memory\` / `voice\` folder in Explorer.

## Voice

Speech runs in the shell (`app/src-tauri/src/voice/`), with the official `sherpa-onnx` crate for speech-to-text and Kokoro, and the OS voices (Windows OneCore, `Windows.Media.SpeechSynthesis`) for the default text-to-speech.

- **Hold to talk:** holding the summon key past the tap limit stops any speech, opens the microphone (16 kHz mono) and sends `talk_start`, then `talk_level` while it records. Release sends `talk_end` with the transcription; under about 0.3 s of audio, or silence, gives `""`. A recording stops at 60 s. While "Pause listening" is on, a hold acts like a tap.
- **Models:** downloaded the first time they are needed into `models\<id>\` in the data folder, from the k2-fsa GitHub releases at pinned URLs, checked against a pinned SHA-256 and unpacked into a temporary folder that is renamed into place. A hold before the model exists starts the download (progress on the eyes) and keeps the recording; it is transcribed when the download finishes. The recogniser loads on first use and unloads after 3 idle minutes; so does Kokoro.

| id | kind | default | download | release asset (k2-fsa `asr-models` / `tts-models`) |
|---|---|---|---|---|
| `moonshine-base` | stt | yes | 111 MB | `sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2` (English, quantized) |
| `whisper-base-en` | stt | | 209 MB | `sherpa-onnx-whisper-base.en.tar.bz2`; only the int8 encoder and decoder are kept |
| `parakeet` | stt | | 482 MB | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2` (English); optional, larger and more accurate |
| `kokoro` | tts | | 110 MB | `kokoro-int8-en-v0_19.tar.bz2` plus `lexicon-en-us.txt`; optional, `os` (no download) is the default |

The URLs, sizes and SHA-256s are constants in `voice/models.rs`. Only the files a model uses are unpacked (no test WAVs, no fp32 copies).

- **Download details:** `download_progress` starts at `fraction: 0`, comes at most 10 times a second, and stays below 1 until the folder is in place. Each model downloads at most once at a time; `voice_model_download` while it is downloading or installed does nothing, and `voice_model_remove` while it is downloading fails. Removing a model unloads it first. HTTPS uses SChannel and the Windows certificate store on Windows (ureq `native-tls`) and rustls elsewhere. If the download fails, the hold that was waiting for it gets `talk_end ""` after the `voice_error`. Only the latest recording waits for a download; an earlier one in the same wait gets no `talk_end`.
- **Recording:** the default input device at its own rate and format, mixed to mono and resampled to 16 kHz when the hold ends (windowed-sinc low-pass, then linear interpolation). `talk_level` is the loudest block since the last report on a log scale (-60 dBFS = 0, -10 dBFS = 1). "Silence" means no 30 ms window reaches about -48 dBFS. Microphone errors send `voice_error` with what to do (no device; on Windows, the privacy switch for desktop apps) and `talk_end ""`.
- **Speaking:** `speak` stops whatever is playing and starts again. `speech {playing: true}` comes when audio reaches the device, `{playing: false}` when it ends, fails or is stopped (`stop_speaking`, `Esc`, a new hold); a `speak` that replaces another sends no `false` in between. OneCore synthesises a WAV that is played through cpal, like Kokoro. Kokoro streams sentence by sentence and uses `sid` 0. It reads words from its lexicon, so words the lexicon lacks (names like "Winku") are skipped. With `tts: "kokoro"` before Kokoro is downloaded, `speak` starts the download and uses the OS voice meanwhile. On Linux and macOS, `os` uses `spd-say` if it is installed, otherwise `voice_error` "Speech isn't available on this platform yet".
- **Threads and memory:** nothing voice-related is created at startup. Each hold records on its own thread (cpal streams stay on the thread that made them) and transcribes there; downloads and `speak` get threads too. While a model is loaded, a thread checks every 20 s and drops models idle for 3 minutes, then exits. sherpa-onnx (with onnxruntime) is linked statically, which adds about 30 MB to the executable. Its Windows libraries are built against the static C runtime (`/MT`), so `app/src-tauri/.cargo/config.toml` sets `+crt-static` for the MSVC targets.

- **When it speaks** (`settings.voice.reply`): `mirror` speaks a reply only when the prompt was spoken, `always_voice` speaks every reply, `always_text` speaks none. The UI decides and calls `speak` on `reply_end`; actions are never spoken. `Esc` and a new hold stop speech.
- **Engine:** a spoken prompt carries `spoken: true`. The engine adds "(spoken)" to the now line so the model knows it was dictated and keeps the answer short and easy to listen to.

## Shipping

- **Updater:** `tauri-plugin-updater`, checking `https://github.com/RyderAsKing/Winku/releases/latest/download/latest.json`. Every update is verified against the public key in `tauri.conf.json`; CI signs releases with the private key in the `TAURI_SIGNING_PRIVATE_KEY` secret. `settings.updates`:
  - `auto` (default): check 30 s after start and every 6 hours, download in the background, then install when Winku quits (or on "Restart to update"). The eyes show a small dot from `update_ready` until then.
  - `notify`: check on the same schedule but don't download; the dot and "Restart to update" appear when one is available.
  - `off`: never check; Settings "Check now" still works.

  Debug builds never check on their own.

  Shell details (`src-tauri/src/update.rs`): the shell has no JS permissions for the updater; everything goes through `update_*`. Signatures are checked when the update is installed, not after the download. `update_ready` is sent once per change into `ready` (auto) or `available` (notify/off). Only the Quit menu item installs on the way out; any other exit (a crash, a system shutdown) leaves the downloaded update for the next check. Windows uses native TLS for update downloads (like the model downloads); other platforms use rustls.
- **Launch at login:** `tauri-plugin-autostart` (the Run key on Windows), applied at startup and whenever `settings.launchAtLogin` changes. Release builds only.
- **Fullscreen apps:** the resting pill hides while a fullscreen app has focus (a game, a video, a presentation) and comes back when it loses focus. Windows watches foreground changes with a WinEvent hook rather than polling. The bar is never hidden this way. (`src-tauri/src/fullscreen.rs`.) The hook thread listens for `EVENT_SYSTEM_FOREGROUND`, plus `EVENT_OBJECT_LOCATIONCHANGE` restricted to the foreground window's thread, so an app that goes fullscreen after it takes focus is caught too. A window counts as fullscreen when its rect covers its monitor's rect and its class isn't `Progman`, `WorkerW`, `Shell_TrayWnd` or `Shell_SecondaryTrayWnd`. Winku's own windows never count. The pill shows again only if `eyes.hidden` is off.
- **Releases:** pushing a `v*` tag runs `.github/workflows/release.yml`. It builds the engine and the NSIS installer on Windows, signs the updater artifacts, and publishes a GitHub Release with `latest.json`. Builds are not code-signed (SPEC §1); the README explains SmartScreen.

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
  memory.ts      MEMORY.md index + topic files, save/undo/forget, memory tools (step 5)
  voice.ts       voice profiles, proposals, voice_propose tool              (step 5)
  requests.ts    engine → shell Requests, correlated with their Responses (timeouts, abort)
  tools/         agent tools: index (assembly), shell (PowerShell/bash choice), find (glob backend),
                 open, web (web_fetch, web_search), screen (look_at_screen), permission (gate),
                 images (compaction drops screenshots)                        (step 6)

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
  voice/         hold to talk, models, speech                                (step 7)
    mod.rs       sessions, pending transcription, downloads, speak/stop, idle unload
    mic.rs       cpal capture, talk level, microphone error advice
    audio.rs     pure DSP: mono mix, resampling, level, silence check, WAV reader
    stt.rs       sherpa-onnx recogniser per model, load-once/unload-when-idle Slot
    tts.rs       cpal player, Kokoro, OneCore (WinRT) / spd-say
    models.rs    model table: pinned URLs, sizes, SHA-256s, files kept
    download.rs  streaming download, checksum, .tar.bz2 unpack, progress throttle

app/ui/src/
  main/          the main window: Eyes, Bar, Transcript, Connect form, toasts
  settings/      Settings window
  history/       History window
  lib/           settings.ts, engine.ts (typed invoke/listen wrappers), shared components
```

## Testing and CI

- Engine: `bun test` against pi-ai's scripted test model (`winku-faux`), no keys or network. Pure modules (mood stripper, prompt builder, memory index) get unit tests. Everything also runs against the compiled binary in CI.
- Shell: `cargo test` for pure logic (settings defaults and migration, snapping, tap/hold timing, hotkey parsing, resampling and levels, the model table, downloads against an in-memory server, idle unload with an injected clock). Platform code is behind traits so the logic is testable on Linux. Linux builds need `libasound2-dev` for cpal.
- Voice end to end (downloads about 220 MB, so not in CI): `WINKU_VOICE_E2E=/tmp/winku-e2e cargo test --release e2e -- --ignored --nocapture` in `app/src-tauri` installs moonshine-base and Kokoro, has Kokoro say a sentence and checks that Moonshine transcribes it.
- UI: `svelte-check`, a Vite build, and `bun run test` for the pure eye logic (`ui/src/lib/eyes/look.ts`: mood looks, the hearts cooldown, lids, colours).
- UI audit: with Vite running, `cd app && BASE_URL=http://localhost:5173 bun run ui-audit` checks keyboard activation, Tab out of hotkey fields, accessible field names, long content staying inside its box, and AA text contrast. docs/research/design-review.md has the last full design review.
- Eyes motion budget: `cd app && bun run motion-check` starts Vite and drives the mock shell in Chromium. It checks that the resting pill runs no animations, that the idle bar runs no endless loop, that the speaking bounce runs only while the bar shows, and that "reduce motion" stops every loop. Windows CI also samples idle CPU for the whole process tree with the pill showing (`scripts/measure-memory.ps1`).
- Eyes gallery: `http://127.0.0.1:5173/eyes.html` under `bun run ui:dev` shows every state, tint and lid level at pill size (`?animate=1` turns the loops on). It is dev-only and not part of the build.
- Screenshots: `cd app && bun run ui:dev` (http://127.0.0.1:5173), then `bun run screenshots [before|after] [case …]`. Output goes to `app/.screenshots/<label>/`. Outside Tauri the UI runs on the browser mock shell (`app/ui/src/lib/mock.ts`), with canned replies, transcript and history, so no keys or engine are needed. Cases: `pill`, `pill-full-context`, `bar`, `reply`, `error`, `cleared`, `chips`, `transcript`, `connect`, `action-show`, `action-no-selection`, `memory-saved`, `eyes` (the gallery), `settings`, `settings-memory`, `settings-actions`, `settings-keys-warnings`, `history`. Sizes are a normal and a high-DPI desktop; Winku has no mobile layout.
- CI: the Windows job builds everything, runs all tests, runs the smoke test and records idle memory and CPU. A Linux job runs the same checks faster.

## Decisions not spelled out in the spec

- **One morphing main window** rather than separate pill and bar windows: one renderer instead of two keeps memory down. Settings and History are created on demand.
- **The UI drives interaction; the shell handles the OS.** The shell does the time-critical parts of a hotkey (grab the selection before focus moves) and then hands off to the UI through a `ui` event.
- **Frozen system prompt lives in the thread.** pi records the prompt as a system message in the session file; when a thread is reopened (restart, Undo, Restore) the engine reuses that preamble instead of rebuilding it, so a settings change only reaches the prompt after a clear or a compaction.
- **Thread pointer file** (`engine\current.json`) instead of "most recent session file", so Restore survives a restart even before the restored thread gets a new message.
- **Tap/hold threshold** of 250 ms on the summon key.
- **Mood tags beyond the spec table.** The engine accepts `happy`, `hearts`, `neutral`, `sad`, `surprised` and `thinking`. After a reply: `happy` and `hearts` show those looks, `sad` droops the outer corners, `surprised` widens the eyes, `thinking` shows the thinking pose in the resting tint ("pondering"), and `neutral` shows nothing. Without a tag the fallback is happy, or hearts if the user said thanks.
- **Hearts stay rare** with a 15-minute cooldown: hearts asked for again within it show as happy. The system prompt also tells the model to use hearts rarely.
- **Sleeping is still.** The spec's table gives sleeping a slow breathing loop, but the motion budget freezes all animation while the eyes are asleep. The budget wins, so sleeping shows still crescents.
