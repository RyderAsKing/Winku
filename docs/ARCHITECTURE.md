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
- Engine → shell: **Requests** `{type:"request", id, method, params}` for things only the shell can do (`screen_capture`, `screen_target`) or only the user can decide (`permission`). The shell answers with a **Response**.
- Prompt ids and action ids are chosen by the sender and echoed on every event of that reply.
- `reply_end` is sent on `agent_settled`, not `agent_end`, so retries and compaction finish first.
- The engine strips `<mood:…>` tags from streamed text and reports the mood on `reply_end`.
- A prompt with `speak` (`"brief"`, `"enough"` or `"full"`, from `settings.voice.say`) gets a reply that starts with `<say>…</say>`, written for listening (the instructions are in the system prompt; `speak="…"` on the now line asks for it). The engine sends each closed block as a `say` event and keeps it out of `text_delta` and `reply_end.text`; a reply with nothing written ends with its last block as the text. Without `speak`, `<say>` is left alone. The transcript drops the blocks the same way (`say.ts`).
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
| `window_mode` | `{ mode: "pill" \| "bar" \| "transcript" }` → `()` (focus and visibility only) | 2 |
| `window_shape` | `{ width, height, shapes: { x, y, w, h }[] }` → `{ alignRight, above }` (the stage size and the shapes drawn on it, logical px from the stage's top-left) | 2 |
| `window_layout` | `{}` → `{ alignRight, above } \| null` (which way things grow from the pill) | 2 |
| `open_window` | `{ name: "settings" \| "history" }` → `()` | 2 |
| `context_menu` | `()` → `()` (native menu at the cursor) | 2 |
| `open_external` | `{ url }` → `()`; http(s) only, opens the default browser | 2 |
| `hotkeys_status` | `()` → `{ failed: { name, binding, error }[] }`: bindings that didn't register | 2 |
| `hotkeys_altgr` | `()` → `{ altGr: boolean \| null, keys: string[], conflicts: string[], suggestion }`: whether `Ctrl+Alt` is AltGr in the current layout and which bindings it breaks | 2 |
| `open_data_path` | `{ what: "about_me" \| "memory" \| "voice" }` → `()`: opens the file or folder (see "Memory and voice profiles") | 5 |
| `now_line` | `()` → `NowLine` captured when the bar was summoned | 6 |
| `screenshot` | `()` → `ImageAttachment` of the window that was active before the bar | 6 |
| `speak` / `stop_speaking` | `{ text, append? }` / `()`. `speak` replaces anything already playing, with the voice from `settings.voice.tts` (and `osVoice`); with `append` it is read after what is playing and queued, or at once if nothing is. Plain text: a `say` block, or a reply's markdown stripped by the UI. | 7 |
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
| `ui` | `{ kind: "summon" }`, `{ kind: "hide" }`, `{ kind: "toggle_transcript" }`, `{ kind: "ask_selection", text }`, `{ kind: "attach_screenshot", image }`, `{ kind: "clear" }`, `{ kind: "cycle_thinking" }`, `{ kind: "action_started", id, slot, name, output }`, `{ kind: "action_error", id?, slot, name, message }`, `{ kind: "talk_start" }`, `{ kind: "talk_level", level }` (0–1, at most 15 a second), `{ kind: "talk_end", text }` (`""` when nothing was heard), `{ kind: "speech", playing }` (text-to-speech started or finished), `{ kind: "voice_error", message }`, `{ kind: "menu", item }`, `{ kind: "update_ready", version }` (an update is downloaded, or available in `notify` mode: the eyes show a small dot), `{ kind: "layout", alignRight, above }` (the pill was moved across the screen's middle), `{ kind: "hotkey_hint", show }` (the hotkey prefix, `Ctrl+Alt` or the leader key, has been held alone for 450 ms: `show: true`; `show: false` when it is released or another key goes down; never sent while a fullscreen app has focus. Read through Raw Input on a dedicated thread, no keyboard hook; elevated windows don't deliver raw input to Winku, so no hints there) |
| `settings_changed` | `Settings`, to every window after any change (Settings window, menu, tray, a saved pill position) |
| `hotkeys_status` | Same payload as the `hotkeys_status` command, after every (re-)registration |
| `update_status` | `UpdateStatus`, whenever it changes |
| `download_progress` | `{ what: "stt" \| "tts", model, fraction }` while a voice model downloads; `fraction: 1` when it is installed. A failure sends `ui` `voice_error` and `{ ..., fraction: -1 }`. |

Global hotkeys are handled in the shell, which does the OS-side work (capture the selection before the bar takes focus, take the screenshot) and then emits a `ui` event. The UI does the rest. `Esc` and `Ctrl+J` are ordinary in-window keys.

Actions (`Ctrl+Alt+1…5`, SPEC §6) start in the shell:

1. Remember the foreground window, wait (up to 600 ms) for the hotkey's modifiers to be released, then capture the selection: UI Automation's TextPattern first, then a simulated `Ctrl+C` that saves every clipboard format first and restores them after. Chromium windows (`Chrome_WidgetWin_*`, or a focused `Chrome_RenderWidgetHostHWND`: Chrome, Edge, Electron apps, WebView2) go straight to the copy: any UI Automation query switches on Chromium's full accessibility tree until the app restarts, which slows it down.
2. Nothing selected: emit `ui` `action_error` ("Select some text first"). Otherwise send `run_action` with a fresh id (`action-<n>`) and emit `ui` `action_started` with that id.
3. replace: on `action_end` for that id (not aborted, non-empty), bring the remembered window back to the front, put the text on the clipboard, send `Ctrl+V`, and restore the previous clipboard about 500 ms later. The target app's own `Ctrl+Z` undoes the paste. If pasting fails, emit `action_error` and the UI shows the result in the bar instead.
4. show and agent: the UI opens the bar with the reply (`action_delta`/`action_end` for show; the usual prompt events for agent).

`Ctrl+Alt+Q` (ask about the selection) uses the same capture and emits `ask_selection`. The bar is not opened for replace actions; the eyes on the pill show thinking, then happy or error.

## Windows

- **Main window** (label `main`): transparent, undecorated, always on top, skipped in the taskbar, no shadow. One webview that morphs, so only one renderer stays alive (the memory budget is 150 MB and WebView2 already takes about 62 MB).
  - Everything grows out of the pill. The window is a fixed **stage**, as wide as the open bar and as tall as the pill plus the tallest bubble, with the pill in one corner: the right corners when the pill is on the right half of its monitor, the bottom ones when it is in the lower 40% (`window::layout_for`). The bar stretches from the pill along the top (or bottom) edge and the bubble hangs under (or over) it.
  - The UI reports the stage size and the shapes it draws (`window_shape`; `app/ui/src/main/stage.ts`). On Windows the window is always the stage and is clipped to those shapes with `SetWindowRgn`, so the transparent rest neither paints nor takes clicks, and nothing is resized while a reply streams. Growth is reported at once; shrinking after the close animation. Elsewhere there is no clipping, so a bare pill keeps a pill-sized window. Moves and resizes go through one `SetWindowPos` so no frame shows the old size at the new place.
  - Sizes by `eyes.size` (logical px): small pill 92×56, bar 400, bubble up to 360; medium 116×70, 480, 420; large 140×84, 560, 480. The table lives in `stage.ts` and `EyeSize::pill`.
  - `pill`: at the remembered position (default: right edge, a third of the way down the primary monitor). Doesn't take focus. Draggable; snaps to the nearest screen edge within 24 px on release; the pill's position is saved per monitor setup. Changing the size keeps a flush edge flush (otherwise the centre).
  - `bar` and `transcript`: take focus. Replies under the resting pill (spoken prompts, actions, errors, permission asks) open the bubble without opening the bar.
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
  "eyes": { "hidden": false, "size": "small", "positions": {} },   // size: small | medium | large; positions keyed by monitor-layout signature
  "voice": { "stt": "moonshine-base", "tts": "supertonic", "ttsVoice": 5, "osVoice": null, "reply": "mirror", "say": "enough", "listeningPaused": false },
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
| `look_at_screen` | asks the shell for a `screen_capture`; image only if the Main model takes images; outside Chromium windows also a short outline of the window's controls (see "Computer use") | no |
| `desktop_observe`, `desktop_windows`, `desktop_wait` | computer use: read a window's controls, list windows, wait for something to appear (see "Computer use") | no |
| `desktop_act`, `desktop_press`, `desktop_window` | computer use: act on a control, press keys, focus/launch/minimize/maximize/restore a window | yes; allowKey `desktop:<app>` |
| `memory_save`, `memory_read`, `voice_propose` | see "Memory and voice profiles" | no |

- Tools run in the user's home folder (not the data folder). pi's session keeps the data folder as its cwd (isolation); each tool call sees the home folder as its cwd instead.
- **`open`** only opens http(s) URLs (every other scheme, such as `file:`, `javascript:` or `ms-settings:`, is refused), paths that exist (UNC and device paths are refused), and app names made of letters, digits, spaces and `. _ - ( ) +`. On Windows a URL goes to `rundll32 url.dll,FileProtocolHandler`, a path to `explorer.exe`, an app name to `cmd /d /c start "" "<name>"`; macOS uses `open` (`open -a` for apps), Linux `xdg-open` (an app name is started directly). Nothing goes through a shell except the restricted app name.
- **`web_fetch`** resolves the host first and refuses loopback, private, link-local, CGNAT, multicast and reserved addresses (v4 and v6, including v4-mapped), `localhost`, `*.local` and `*.internal`. Redirects (at most 5) are followed by hand and each hop is checked again. 15 s timeout, 2 MB download, 20,000 characters of text; HTML loses scripts, styles, navigation and forms, and keeps headings, list items and links (`text (url)`) as text. Binary content types are refused.
- **`web_search`** calls the Brave Search API (`X-Subscription-Token`) and returns title, URL and snippet for the top 8 results.
- **`look_at_screen`** sends `screen_capture` with `includeImage` = the Main model takes images, waits up to 10 s, and returns the app, window title, window id (`w-<HWND>`) and UI Automation text, plus the screenshot as image content when there is one. In a Chromium window the shell skips the UI Automation text when there is a screenshot (`chromium: true` in the capture); without a screenshot it still reads it, since the model would otherwise see nothing. When computer use is available and the window isn't Chromium, the engine appends a compact interactive snapshot (about 2,500 characters) so the model can act without another round trip.
- **Ask before running** (off by default; right-click menu and Settings): before a gated tool runs, the engine sends a `permission` Request with `{ replyId, tool, summary, allowKey }` unless `allowKey` is in `alwaysAllow` (compared case-insensitively). The bar shows Allow once / Always allow this command / Deny. "Always" also adds the key to `settings.alwaysAllow` (the engine adds it to its in-memory list at once). Deny gives the model a tool result saying the user declined. `Esc` (abort) denies any pending request; so does an error Response or no answer within 30 minutes. Summaries: `Run: <command>`, `Write <absolute path>`, `Edit <absolute path>`, `Open <target>`, `Set textfield "Search" to "…" in notepad.exe "Untitled - Notepad"`, `Press ctrl+s in …`, `Launch notepad`; `write`/`edit` keys use the absolute path, the desktop tools `desktop:<app>` (process name, lower case, without `.exe`). A `desktop_press`/`desktop_window` call without a window id is always asked about, because its app isn't known until it runs.
- **"Always allow" never covers a compound command.** A `powershell`/`bash` command that chains, pipes, redirects, substitutes or spans lines (`;`, `&`, `|`, `<`, `>`, `` ` ``, `$(`, a newline) is always asked about, even when its first word is in `alwaysAllow`; otherwise `ls; rm -rf ~` would ride on `bash:ls`.
- **Settings changes keep the reply running.** A `configure` that only changes `askBeforeRunning`, `alwaysAllow` or `searchApiKey` updates them in place: no session rebuild, no abort. Adding or removing the search key switches `web_search` on or off once the current reply settles.
- **Now line:** when the bar is summoned (hotkey or pill click), the shell notes the foreground app (process name), its window title and its selection (UI Automation only, never a simulated copy; skipped in Chromium windows for the reason above, so there is no selection chip there). `now_line` returns that snapshot; the UI sends it with each prompt and the engine appends it to the user message.
- **Screenshot hotkey** (`Ctrl+Alt+S`): the shell captures the foreground window (downscaled like `screen_capture`) and emits `ui` `attach_screenshot`; the UI shows it as a chip and sends it with the next prompt.
- **Compaction drops screenshots:** images in the kept part of the thread are replaced by "[screenshot removed]" when the thread is compacted. This happens in what is sent to the model (a context transform on the session's agent): the session file keeps the images, so the transcript still counts them, and images sent after the compaction are untouched.
- **Tool events** carry a short summary without the tool name (the UI shows `name: summary`): the command's first line for shells, the file name for `read`/`write`/`edit`, the URL, query or target for the web tools and `open`, the action and ref (`set value @s1:e2`), keys, window or wait text for the desktop tools.

## Computer use

SPEC §7. The agent operates desktop apps through their accessibility tree with [agent-desktop](https://github.com/vercel-labs/agent-desktop) (vercel-labs, Apache-2.0, Rust), bundled with Winku. agent-desktop reads a window through UI Automation, returns a tree in which every actionable element has a ref (`@<snapshot id>:e<N>`), and acts on refs semantically (Invoke, Value, Toggle, ExpandCollapse, SelectionItem, Scroll patterns) without moving the pointer or changing focus. It has no model inside: the loop runs in our agent. Code: `engine/src/tools/desktop/` (`cli.ts` runner, `render.ts` output, `index.ts` tools).

**Tools** (only registered when the CLI is found next to the engine, `WINKU_AGENT_DESKTOP_BIN` overrides):

| Tool | Params | agent-desktop |
|---|---|---|
| `desktop_observe` | `window?`, `root?` (drill into a ref), `surface?` (`menu`, `sheet`, `focused`) | `snapshot -i --compact --window-id <id>` (or `--root <ref>`); a window whose outline passes 6,000 characters is read again with `--skeleton` (depth 3, `children_count` on cut containers, drill targets) |
| `desktop_act` | `ref`, `action` (click, double_click, right_click, type, set_value, clear, select, check, uncheck, toggle, expand, collapse, scroll, scroll_to, focus), `text?`, `direction?`, `amount?`, `observe?` | the matching ref command; then, unless `observe: false`, a fresh snapshot of the same window (2,500 characters) so the model verifies in the same step |
| `desktop_press` | `keys`, `window?` | `press --headed --window-id <id> -- <keys>` |
| `desktop_windows` | none | `list-windows`, minus Winku's windows; marks the target |
| `desktop_window` | `action` (focus, launch, minimize, maximize, restore), `window?`, `app?` | `focus-window` / `minimize` / … `--headed --window-id <id>`; `launch --activate -- <app>` (System32 names or full paths; other apps go through `open`) |
| `desktop_wait` | `text?`, `role?`, `gone?`, `window?`, `ms?` | `snapshot … --wait-for <role:text>` (or `--wait-for-gone`), which returns the fresh tree; with only `ms`, an abortable pause (≤ 30 s) |

- **The target.** "The window" is the one the user was in before the bar: the engine sends a `screen_target` Request and the shell answers `ScreenTarget { windowId: "w-<HWND>", app, windowTitle, chromium }` for the same window `look_at_screen` uses (`capture::request_window`: the window before the bar while the bar shows, else the foreground window; an error when that is one of Winku's own). `screen_target` uses Win32 calls only, so it costs nothing in any app. Every snapshot is scoped with `--window-id`; nothing ever falls back to "the focused window", which would be the bar.
- **Winku's own windows** are never observed or acted on: the shell never returns them as the target, `desktop_windows` drops windows of the shell's process (`process.ppid`) or named `winku`, a window id must be the target, one listed that way, or one `launch` returned, and refs are accepted only from snapshots the engine took in this process (so they belong to an allowed window).
- **Headless first.** Every ref action is headless (no pointer, no focus change) except those that have no semantic path on Windows: `type` (SendInput keystrokes at the caret), `double_click`, `right_click`, `focus` and `desktop_press`, which pass `--headed` and may bring the window to the front. The tool descriptions steer the model to `set_value` for filling fields. A headless failure never silently falls back to physical input.
- **Loop rules** live in the tool descriptions (the system prompt only says to use the desktop tools and to observe, act, check): observe before acting; refs belong to their snapshot; on `STALE_REF` / `SNAPSHOT_NOT_FOUND` observe again; retry only when `disposition.retry` is `safe` ("Nothing was sent"); otherwise look first, because a repeat can click or type twice. Errors come back as tool errors with the code, kind, suggestion, retry advice and recovery hint (`render.ts renderError`).
- **Compact results.** Trees are rendered as an indented outline, one line per node (`button "Save" @s1:e3 [focused]`), names cut at 80 characters and values at 160, quiet states (`enabled`, `visible`, …) dropped, capped at 6,000 characters for an observe and 2,500 after an action or in `look_at_screen`, with a note when lines were cut. Typed text goes through `--stdin`, never the command line.
- **One process per call, not `agent-desktop mcp`.** The MCP server is a dispatcher: it runs each tool call by spawning the same CLI binary (`src/mcp/call.rs`), so it can't be faster than spawning it ourselves, and it fixes `--headed` for the whole server, while we choose it per action. Measured on CI (windows-latest, `test/desktop-e2e.ts`, medians of 5): see the PR that added this; on Linux both are about 2 ms per `version`/`list-windows` call. The CLI keeps snapshots and their ref maps on disk (pruned by agent-desktop), so per-call processes lose nothing. Each call has a hard timeout (its own budget plus 10 s).
- **Esc** aborts the reply's signal; the runner kills the running agent-desktop process at once (TerminateProcess on Windows), and pauses and waits stop. A killed `type` or `press` can leave part of the text typed; the next observe shows what landed.
- **State.** `AGENT_DESKTOP_HOME` is `%APPDATA%\winku\engine\agent-desktop\`, so snapshots (which hold window text) stay in Winku's data folder, not `~\.agent-desktop`. `AGENT_DESKTOP_SESSION` from the user's environment is ignored.
- **Chromium cost.** Any UI Automation query against a Chromium window (Chrome, Edge, Electron apps such as VS Code, Slack and T3 Code, WebView2 hosts) switches on its full accessibility tree until the app restarts, which slows busy pages and editors noticeably (found in #15). The rule: **passive context never reads a Chromium window; operating one because the user asked is fine.** So the per-summon selection read skips Chromium windows (`platform::uia_is_safe`, unchanged), `look_at_screen` neither snapshots a Chromium window nor reads its UI Automation text when it has a screenshot, and only `desktop_observe`/`desktop_act`/`desktop_wait` (which the model uses to operate an app) read one. Their descriptions say so, and a Chromium target gets a 15 s snapshot budget because its first read comes back thin while the renderer builds its tree. `screen_target`, `list-windows`, `list-apps`, `launch` and `focus-window` are Win32-only and never touch UI Automation.
- **Bundling.** The CLI is a Tauri sidecar (`bundle.externalBin` `binaries/agent-desktop`), installed beside `winku.exe` and `winku-engine.exe`, where the engine looks for it. `app/scripts/stage-agent-desktop.ts` (run by `bun run engine`) downloads the pinned release archive (v1.2.0, about 1.7 MB, a 3.8 MB exe), checks its SHA-256 against the value pinned in the script before unpacking, and caches it in `app/.cache/`; there is no download at runtime. The licence notice is `app/src-tauri/licenses/agent-desktop.txt`, installed as a resource.

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

Speech runs in the shell (`app/src-tauri/src/voice/`), with the official `sherpa-onnx` crate for speech-to-text and Supertonic text-to-speech (the default), and the OS voices (Windows OneCore, `Windows.Media.SpeechSynthesis`) as the fallback.

- **Hold to talk:** holding the summon key past the tap limit stops any speech, opens the microphone (16 kHz mono) and sends `talk_start`, then `talk_level` while it records. Release sends `talk_end` with the transcription; under about 0.3 s of audio, or silence, gives `""`. A recording stops at 60 s. While "Pause listening" is on, a hold acts like a tap.
- **Models:** downloaded the first time they are needed into `models\<id>\` in the data folder, from the k2-fsa GitHub releases at pinned URLs, checked against a pinned SHA-256 and unpacked into a temporary folder that is renamed into place. A hold before the model exists starts the download (progress on the eyes) and keeps the recording; it is transcribed when the download finishes. The recogniser loads on first use and unloads after 3 idle minutes; so does Supertonic.

| id | kind | default | download | release asset (k2-fsa `asr-models` / `tts-models`) |
|---|---|---|---|---|
| `moonshine-base` | stt | yes | 111 MB | `sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2` (English, quantized) |
| `whisper-base-en` | stt | | 209 MB | `sherpa-onnx-whisper-base.en.tar.bz2`; only the int8 encoder and decoder are kept |
| `parakeet` | stt | | 482 MB | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2` (English); optional, larger and more accurate |
| `supertonic` | tts | yes | 85 MB | `sherpa-onnx-supertonic-tts-int8-2026-03-06.tar.bz2` (int8, English plus ko/es/pt/fr, MIT, ten voices) |

The URLs, sizes and SHA-256s are constants in `voice/models.rs`. Only the files a model uses are unpacked (no test WAVs, no fp32 copies).

**Why Supertonic.** sherpa-onnx 2.x dropped espeak-ng, so Kokoro, Kitten, Matcha and Piper models need a lexicon and no longer normalise text: numbers, `$`, `%`, ordinals and plurals missing from the lexicon ("gets", "buckets") were silently skipped. Supertonic reads characters and says numbers, currency and dates itself. Measured on a 3-core x86 VM (int8, 3 threads, other jobs running): Supertonic about 0.2 real-time factor and 156-245 MB while loaded, Kokoro v1.0/v0.19 1.2-1.5 and ~420 MB, Kitten nano 0.3 but dropped numbers. Transcribed back with Moonshine, Supertonic returned the numbers sentence word for word; Kokoro and Kitten lost the numbers.

- **Download details:** `download_progress` starts at `fraction: 0`, comes at most 10 times a second, and stays below 1 until the folder is in place. Each model downloads at most once at a time; `voice_model_download` while it is downloading or installed does nothing, and `voice_model_remove` while it is downloading fails. Removing a model unloads it first. HTTPS uses SChannel and the Windows certificate store on Windows (ureq `native-tls`) and rustls elsewhere. If the download fails, the hold that was waiting for it gets `talk_end ""` after the `voice_error`. Only the latest recording waits for a download; an earlier one in the same wait gets no `talk_end`.
- **Recording:** the default input device at its own rate and format, mixed to mono and resampled to 16 kHz when the hold ends (windowed-sinc low-pass, then linear interpolation). `talk_level` is the loudest block since the last report on a log scale (-60 dBFS = 0, -10 dBFS = 1). "Silence" means no 30 ms window reaches about -48 dBFS. Microphone errors send `voice_error` with what to do (no device; on Windows, the privacy switch for desktop apps) and `talk_end ""`.
- **Speaking:** `speak` stops whatever is playing and starts again. `speech {playing: true}` comes when audio reaches the device, `{playing: false}` when it ends, fails or is stopped (`stop_speaking`, `Esc`, a new hold); a `speak` that replaces another sends no `false` in between. The reply is cut into sentences (`tts::split_sentences`: not inside "3.5", "e.g." or "Dr.", list lines on their own, short ones merged, very long ones cut at commas), each synthesised in turn and lifted towards -22 dBFS RMS (Supertonic is quiet; at most 3x, never past a 0.95 peak) while the previous one plays. The voice is `settings.voice.ttsVoice` (0-4 female, 5-9 male, default 5). With `tts: "supertonic"` before it is downloaded, `speak` starts the download and uses the OS voice meanwhile. Settings files from v0.1.0 (`tts: "os"`, no `ttsVoice`) move to Supertonic once; the removed `kokoro` option does too. OneCore synthesises a WAV that is played through cpal, like Supertonic. On Linux and macOS, `os` uses `spd-say` if it is installed, otherwise `voice_error` "Speech isn't available on this platform yet".
- **Playback:** `tts::play` resamples the synthesiser's rate (44.1 kHz for Supertonic, 22.05-24 kHz for others) to the device's with `audio::StreamResampler`, a streaming Blackman-windowed sinc (48 taps each side at 1:1, table of 512 sub-sample phases), the same result however the audio is chunked. It replaced linear interpolation, which left images of the voice only about 9 dB below the original at 9 kHz when going from 24 to 48 kHz.
- **Threads and memory:** nothing voice-related is created at startup. Each hold records on its own thread (cpal streams stay on the thread that made them) and transcribes there; downloads and `speak` get threads too. While a model is loaded, a thread checks every 20 s and drops models idle for 3 minutes, then exits. sherpa-onnx (with onnxruntime) is linked statically, which adds about 30 MB to the executable. Its Windows libraries are built against the static C runtime (`/MT`), so `app/src-tauri/.cargo/config.toml` sets `+crt-static` for the MSVC targets.

- **When it speaks** (`settings.voice.reply`): `mirror` speaks a reply only when the prompt was spoken, `always_voice` speaks every reply, `always_text` speaks none (files from before v0.1.3 may say `always` or `never`; the shell maps them). The UI decides when it sends the prompt and sets `speak` on it (`settings.voice.say`). Each `say` event is read as it arrives: the first replaces anything playing, later ones are appended. A spoken reply that ends without any `say` block is read from its markdown, stripped (`speech.ts`), on `reply_end`. Actions are never spoken. `Esc` and a new hold stop speech and drop the queue.
- **Queued speech:** an appended text joins the playing one's queue. Supertonic reads the queue through the same audio stream, so there is no gap; the OS voice reads one text after another.
- **Engine:** a dictated prompt carries `spoken: true`, which adds `spoken="yes"` to the now line so the model expects transcription errors. Whether the reply is read aloud is `speak`, separately: typed prompts are spoken too with `always_voice`.

## Shipping

- **Updater:** `tauri-plugin-updater`, checking `https://github.com/RyderAsKing/Winku/releases/latest/download/latest.json`. Every update is verified against the public key in `tauri.conf.json`; CI signs releases with the private key in the `TAURI_SIGNING_PRIVATE_KEY` secret. `settings.updates`:
  - `auto` (default): check 30 s after start and every 6 hours, download in the background, then install when Winku quits (or on "Restart to update"). The eyes show a small dot from `update_ready` until then.
  - `notify`: check on the same schedule but don't download; the dot and "Restart to update" appear when one is available.
  - `off`: never check; Settings "Check now" still works.

  Debug builds never check on their own.

  Shell details (`src-tauri/src/update.rs`): the shell has no JS permissions for the updater; everything goes through `update_*`. Signatures are checked when the update is installed, not after the download. `update_ready` is sent once per change into `ready` (auto) or `available` (notify/off). Only the Quit menu item installs on the way out; any other exit (a crash, a system shutdown) leaves the downloaded update for the next check. Windows uses native TLS for update downloads (like the model downloads); other platforms use rustls.
- **Launch at login:** `tauri-plugin-autostart` (the Run key on Windows), applied at startup and whenever `settings.launchAtLogin` changes. Release builds only.
- **Fullscreen apps:** the resting pill hides while a fullscreen app has focus (a game, a video, a presentation) and comes back when it loses focus. Windows watches foreground changes with a WinEvent hook rather than polling. The bar is never hidden this way. (`src-tauri/src/fullscreen.rs`.) The hook thread listens for `EVENT_SYSTEM_FOREGROUND`, and owns a hidden appbar window (`ABM_NEW`, never given any space) so Explorer's `ABN_FULLSCREENAPP` re-checks the foreground window when an app goes fullscreen after it takes focus (F11, a video). A location-change hook did this before and fired for every caret move and every pixel of a window drag. A window counts as fullscreen when its rect covers its monitor's rect and its class isn't `Progman`, `WorkerW`, `Shell_TrayWnd` or `Shell_SecondaryTrayWnd`. Winku's own windows never count. The pill shows again only if `eyes.hidden` is off.
- **Sidecars:** `winku-engine` and `agent-desktop` (see "Computer use"), both staged by `bun run engine` into `src-tauri/binaries/`.
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
    desktop/     computer use: cli (agent-desktop runner), render (outlines, errors), index (desktop_* tools)

app/src-tauri/src/
  lib.rs         builder, plugins, command registration
  engine.rs      sidecar, Result correlation for engine_call, Request routing
  settings.rs    schema, defaults, load/save
  secrets.rs     keyring
  hotkeys.rs     registration, tap/hold, leader key, AltGr check
  window.rs      modes, the stage around the pill, shapes, snapping, saved positions
  menu.rs        context menu, tray (only while the eyes are hidden)
  commands.rs    #[tauri::command] functions
  capture.rs     now line, screenshots, the screen_capture and screen_target Requests
  platform/      foreground app, selection, paste, screenshot, UI Automation (windows.rs + fallback.rs)
  voice/         hold to talk, models, speech                                (step 7)
    mod.rs       sessions, pending transcription, downloads, speak/stop, idle unload
    mic.rs       cpal capture, talk level, microphone error advice
    audio.rs     pure DSP: mono mix, resampling, level, silence check, WAV reader
    stt.rs       sherpa-onnx recogniser per model, load-once/unload-when-idle Slot
    tts.rs       cpal player, Supertonic, OneCore (WinRT) / spd-say
    models.rs    model table: pinned URLs, sizes, SHA-256s, files kept
    download.rs  streaming download, checksum, .tar.bz2 unpack, progress throttle

app/ui/src/
  main/          the main window: Eyes, Bar, Transcript, Connect form, toasts
  settings/      Settings window
  history/       History window
  lib/           settings.ts, engine.ts (typed invoke/listen wrappers), shared components
```

## Testing and CI

- Engine: `bun test` against pi-ai's scripted test model (`winku-faux`), no keys or network. Pure modules (mood stripper, prompt builder, memory index) get unit tests. Everything also runs against the compiled binary in CI. Computer use is tested against a fake agent-desktop (`test/fake-agent-desktop.ts`, run with bun): arguments, stdin, targeting, Winku's windows refused, skeleton fallback, error advice, the permission gate, abort.
- Computer use end to end (CI `windows-build`, under a minute): `WINKU_AGENT_DESKTOP_BIN=… bun run test/desktop-e2e.ts` in `engine` drives the real agent-desktop through the tool code: launches Notepad, observes it, sets text, observes again, types, observes again, checks that abort stops a wait, and prints CLI and MCP latencies (`LATENCY {…}` in the log).
- Shell: `cargo test` for pure logic (settings defaults and migration, snapping, tap/hold timing, hotkey parsing, resampling and levels, the model table, downloads against an in-memory server, idle unload with an injected clock). Platform code is behind traits so the logic is testable on Linux. Linux builds need `libasound2-dev` for cpal.
- Voice end to end (downloads about 200 MB, so not in CI): `WINKU_VOICE_E2E=/tmp/winku-e2e cargo test --release e2e -- --ignored --nocapture` in `app/src-tauri` installs moonshine-base and Supertonic, has Supertonic read a sentence with numbers through the playback resampler (writing `playback-48k.wav`) and checks that Moonshine transcribes it.
- UI: `svelte-check`, a Vite build, and `bun run test` for the pure eye logic (`ui/src/lib/eyes/look.ts`: mood looks, the hearts cooldown, lids, colours).
- UI audit: with Vite running, `cd app && BASE_URL=http://localhost:5173 bun run ui-audit` checks keyboard activation, Tab out of hotkey fields, accessible field names, long content staying inside its box, and AA text contrast. docs/research/design-review.md has the last full design review.
- Eyes motion budget: `cd app && bun run motion-check` starts Vite and drives the mock shell in Chromium. It checks that the resting pill runs no animations, that the idle bar runs no endless loop, that the speaking bounce runs only while the bar shows, and that "reduce motion" stops every loop. Windows CI also samples idle CPU for the whole process tree with the pill showing (`scripts/measure-memory.ps1`).
- Eyes gallery: `http://127.0.0.1:5173/eyes.html` under `bun run ui:dev` shows every state, tint and lid level at pill size (`?animate=1` turns the loops on). It is dev-only and not part of the build.
- Screenshots: `cd app && bun run ui:dev` (http://127.0.0.1:5173), then `bun run screenshots [before|after] [case …]`. Output goes to `app/.screenshots/<label>/`. Outside Tauri the UI runs on the browser mock shell (`app/ui/src/lib/mock.ts`), with canned replies, transcript and history, so no keys or engine are needed. Cases: `pill`, `pill-full-context`, `bar`, `reply`, `error`, `cleared`, `chips`, `transcript`, `connect`, `action-show`, `action-no-selection`, `memory-saved`, `eyes` (the gallery), `settings`, `settings-memory`, `settings-actions`, `settings-keys-warnings`, `history`. Sizes are a normal and a high-DPI desktop; Winku has no mobile layout. Mock URL parameters `?size=medium|large`, `?left` and `?low` show the other eye sizes and growth directions.
- Windows desktop screenshots: CI's `windows-build` job runs `app/scripts/windows-shots.ps1` against the release build (resting pill, the bar after a tap of the summon key, closed again) and uploads them as the `windows-shots` artifact.
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
