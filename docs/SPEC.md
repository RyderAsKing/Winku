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

- **Resting eyes:** a dark pill, Small (92×56 px, the default), Medium (116×70) or Large (140×84) in Settings > Eyes. It is always on top, and clicks pass through everything except what Winku is drawing. You can drag it anywhere by the eyes, resting or open, it snaps to screen edges, and it remembers its position. It hides while a fullscreen app has focus. "Hide eyes" is a setting, and a tray icon appears only while the eyes are hidden.
- **Bar:** the pill stretches into the bar where it sits, toward the middle of the screen (leftward when the pill is on the right half). The eyes don't move, opening or closing, and the bubble follows the bar in. The bar is as tall as the pill and 400, 480 or 560 px wide by size. A long message makes it taller, away from the eyes' row, up to four lines; after that the message box scrolls. Attachments float just off the bar on the bubble's side, each in a pill of its own: a screenshot as a small thumbnail, a selection as its first words in quotes. Hovering a pill lights it up. A cut-short selection, hovered a moment, unrolls into a card with all of it (up to seven lines, then it scrolls), growing away from the bar, and rolls back up when the pointer leaves. Clicking the screenshot takes it off; the selection comes off with its ×, so reading it never drops it. After 30 seconds with nothing happening (no typing, no pointer movement or scrolling over Winku, no reply or speech running, the pointer not resting on the bubble) the bar, and the transcript, fold back to the resting pill; what you typed and attached is still there next time. It shows a `23% ctx` meter and a small thinking-level label. They stay in the bar until the message reaches them, then float off it so the message has the whole bar; they come back once it is well short of them again. Off the bar they sit as pills over the bar's eyes end, on the side away from the bubble. When the pill is snapped against that screen edge there is no room there, and they go as one pill at the end of the attachments' row instead.
- **Reply bubble:** replies stream into a translucent rounded bubble just under the bar, or just over it when the pill sits low on the screen. It scrolls when the reply is long, following the newest text while scrolled to the bottom; scrolling up stops that until you scroll back down. The bubble shows one reply. The conversation before it sits above, out of view: scroll up over the bubble and it opens to its full height, and the bar and bubble glide wide (640, 760 or 880 px by size, at most half the monitor) to show it, fading at the edges where there is more; scrolling back down to the end closes it to the reply and its usual width again. When you talk (hold the key), run an action, or something needs your attention, the eyes stay as the pill and the bubble appears under them. While you talk over the resting pill the bar is drawn open to show the words, without taking focus from the app you are in, and closes again once the message is sent. It goes away a while after the reply has finished and been read out (longer for longer replies, never while the pointer is over it); a bubble holding a visual stays until you dismiss it with `Esc` or, with the bar open, by clicking elsewhere. Clicking it opens the bar.
- **Transcript:** `Ctrl+J` shows the whole conversation in a taller bubble under the bar. It renders markdown and code blocks with copy, shows tool calls as collapsed rows, and shows compaction as a collapsible "Earlier conversation summarized" row. Like the reply bubble, it follows new messages while scrolled to the bottom. It goes wide while it holds a visual, so a visual looks the same here as in the reply bubble.
- **Visuals:** when showing beats telling (a chart, a table, a diagram, a small interactive widget), the assistant draws a visual into its reply with the `show` tool. You can ask for one, and the assistant also draws one unprompted when a picture clearly says more than prose; most replies stay text. A visual is a small HTML page with its own scripts, shown in the reply where the model put it and kept in the thread, so the transcript and History show it too. A reply can hold several.
  - While the page is being written the eyes play Drawing and the bubble shows one status line, "Drawing" shimmering like "Thinking", with the visual's title beside it; there is no empty frame. The finished visual arrives in one step, never half-written: the bar and bubble glide wide and the bubble grows to fit it. They come back to their usual width when the bubble closes.
  - The page takes Winku's palette and fonts as CSS variables, has no background of its own so it sits in the translucent bubble, and grows to fit its content; it never scrolls by itself, so anything taller scrolls with the bubble. Pages that size themselves by the viewport (`vh` units) are refused, since a frame that fits its page would grow without end. The HTML the model writes is at most 512 KB; local images are limited separately, to 2 MB each and 6 MB per page.
  - Visuals have a house style: charts and diagrams are drawn as dot matrices in Winku's palette, like the dot field behind the eyes, from a small stylesheet every page gets, and the `show` tool tells the model to use it. A chart's dots rise once when it lands, then stay still. A page sits in a centred column at most 560 px wide, and a chart is as wide as its bars, so in the Wide bubble nothing stretches to the far edges. The bubble holds each visual in a darker well, like a code block, as wide as that column and centred.
  - Clicking a visual opens it larger in the transcript-height bubble at wide width. A small "Open in browser" control opens its file in your default browser.
  - Each page runs in a sandboxed frame on its own origin, apart from Winku: it can't reach the app, the disk, the engine or the thread. It may load pictures and scripts from the web the way a web page does. Local images the model names by path are written into the page, checked by their bytes so only real images go in. Links open in your default browser.
  - The frame and Winku pass only a few messages: the page's height, link and image clicks, Winku's theme, and Winku's keys, so `Esc` and the other shortcuts still work while a visual has focus. Nothing in a page can send a message, run a tool or start a turn.
  - Each visual is saved as its own `.html` file under `%APPDATA%\winku\visuals\`; the thread holds only its id and title. Clearing keeps the files with the History entry, and deleting that entry deletes them.
- **Right-click menu on the eyes:** Settings, History, Ask before running, Hide eyes, Pause listening, Quit, and `Scheduled (n)` while any task is scheduled.
- **Settings:** an ordinary window of about 860×600 px: a list of sections on the left (Model, Conversation, Tools, Speech, Memory and voice, Actions, Keys, Eyes, Schedules, App) and the chosen section on the right, as grouped rows with the setting on the left and its control on the right. On-off settings are switches. A section that needs attention (a key conflict, no model yet) is marked in the list. A narrow window moves the list to a strip along the top.
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
| Drawing | lime `#C8F27A`; one eye grows like a magnifier and the pair follows a point as it plots, while bars of dots rise one after another along the bar, hold, and fade | the model is writing a visual |

- **Mood:** the model may end a reply with a hidden tag such as `<mood:happy>`. The app strips the tag and the eyes react. Simple rules are the fallback when a model ignores the tag.
- **Into and out of Drawing:** the eyes half-blink as they pick up the pen, then ease into the pose and colour over about half a second, slower than other state changes, while the previous state's dots fade out and the plot fades in. Putting the pen down eases back the same way.
- **Context fullness:** the lids lower gradually as context fills, up to about 30% closed at the limit. Compaction plays a small yawn. Clear plays the wipe, then wide, refreshed eyes.
- **Thinking level sets the resting tint:** off = pale mint, low = soft cyan, medium = cyan `#5EF6F0`, high = deep sky blue, max = indigo. State colours take over during activity. Switching level up, the eyes perk up: a crouch, a hop with a stretch and a squashy landing, bigger for higher levels, while the new colour sweeps along the dot field with a trail, further and brighter for higher levels. Back to the bottom they settle instead, with a slow half blink, and the dots draw in toward the eyes and go out. The label rolls up to the new level.
- **Dot field:** behind the face sits a fine grid of dots, blank at rest. It lights up with what Winku is doing, in the eyes' colour, while the pill itself stays still. It shines around the eyes, where there is no text; under the message and the meter it stays faint, so the faintest text over a lit dot still reads at 4.5:1. The one exception is Drawing: its plot may shine in full along the bar's top and bottom edges, which the message never reaches. Listening, rings roll out from the eyes, stronger as you speak up. Thinking, specks drift away from the eyes along the bar. Talking, columns of dots rise and fall like a voice meter. While one of these runs the unlit dots show faintly too, so the matrix looks switched on. Events get a one-off burst: a ring of dots for a reply that went well (two pink ones for hearts), one quick ring when surprised, dots dripping down when sad, rows glitching on and off on an error, and a bright line sweeping across on a clear.
- **Motion budget:** the glow is drawn once as a static layer, and only movement and opacity are animated. Blinks are one-off animations of about 300 ms on a timer, not endless loops. All animation freezes when the bar is hidden or the eyes are asleep. While the agent works, its status label ("Thinking" with the time since the ask, or the running tool) shimmers; nothing shimmers at idle. The dot field draws frames only while one of its effects plays. The OS "reduce motion" setting switches to still frames. The goal is close to 0% CPU at idle.
- The eyes never start a conversation or speak unprompted. The exceptions are error states and a scheduled task the user asked for (section 7).
- **Status dots:** small static dots sit centred under the eyes on the resting pill: one in the accent while an update waits, one in the resting tint while any task is scheduled.
- Known bugs in the research prototype, not to copy: the "cleared" state renders inverted (white pill, black eyes), and the eyelids show as black caps in light mode.

## 5. Keymap

Everything is reachable with the left hand and everything is rebindable (the user has no Caps Lock key). Settings warns about conflicts and detects layouts where `Ctrl+Alt` acts as AltGr, suggesting `Ctrl+Shift` instead. An optional leader key (e.g. F13 on a programmable keyboard) can replace `Ctrl+Alt`.

Holding the prefix (`Ctrl+Alt` or the leader key) alone for about 450 ms shows small hints next to the eyes saying what each key does; they go away as soon as another key goes down or the prefix is released, and never show over a fullscreen app. They draw on top of the chat or reply, which keeps its size and position.

| Keys | Does |
|---|---|
| tap `Ctrl+Alt+Space` | open or hide the bar; with text selected in another app, bring it to the bar (open or not) |
| hold `Ctrl+Alt+Space` | talk; release to send; also interrupts speech |
| `Ctrl+Alt` + `1`–`5` | action slots 1–5 on the selected text |
| `Ctrl+Alt+Q` | ask about the selection (opens the bar with it attached) |
| `Ctrl+Alt+S` | attach a screenshot of the current window |
| `Ctrl+Alt+X` | clear context (wipe + 5 s Undo toast) |
| `Ctrl+Alt+T` | cycle Main's thinking level |
| `Ctrl+Alt+B` | bring Winku here: the eyes glide over to rest just beside the pointer, on its monitor (nothing happens while they are hidden or the pointer is already next to them) |
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
- Selection capture tries UI Automation first, asking the focused control and then its nearest parents, and falls back to a simulated copy that saves and restores the clipboard. It doesn't wait for you to let go of `Ctrl+Alt`: once the action's own key is up, Winku treats the modifiers as released so the copy isn't misread. The copy gets 700 ms to answer before Winku says nothing is selected.

## 7. Agent, tools and screen

- **Tools:** run commands, read and write files, open apps and URLs, web search, `look_at_screen`, the clipboard tools, computer use, the memory tools, and `show`.
- **Computer use:** the assistant can operate desktop apps the way a person would, through the accessibility tree rather than scripts: read a window's controls, click, fill in fields, pick options, toggle, expand, scroll, press keys, and list, focus and launch windows. It works on the window you were in before you summoned it, or another window it picks from the list; it never operates Winku's own windows. It looks again after each action to check what happened. Most actions don't move your pointer or change the focused window; typing keystrokes, keyboard shortcuts, double- and right-clicks do bring the window to the front. It is built on [agent-desktop](https://github.com/vercel-labs/agent-desktop) (Apache-2.0), shipped with Winku.
- **Showing:** `show` takes a title and the page's HTML and puts a visual in the reply (section 3). Its result comes from the real frame once the page loads: the measured height and any script errors, so the model can fix a broken page in its next step. A fixed page can replace the one it fixes, in place, so a dead frame never stays in the thread. `show` never asks, even with "Ask before running" on, and works in scheduled runs, where the wide bubble opens under the pill without taking focus. A spoken reply says nothing of the visual beyond what the model writes in `<say>`.
- **Permissions:** everything is allowed by default and `Esc` stops it immediately. "Ask before running" is an opt-in switch in the right-click menu, off by default. When it is on, a check in front of each tool call shows Allow once / Always allow this command / Deny for anything that writes, deletes, runs or sends input. That includes every computer-use action that sends input or changes an app's state ("always" covers that app); reading a window never asks.
- **Screen awareness:** every message you send carries a small "now" line with the active app, the window title, the selection and a clipboard note (kind and size). Text you select before summoning Winku with its key comes along without `Ctrl+Alt+Q`: it shows in the bar as the selection pill, so "google this and check the facts" works on it. With the bar already open, a tap over another app with text selected adds that text the same way rather than hiding the bar; with nothing selected the tap hides it, and a message you speak over the resting pill carries it too. Winku reads it the way actions do (section 6), but never simulates `Ctrl+C` in a terminal or an editor with a built-in terminal, where it could stop a running program. It goes at the end of the message so caching is unaffected. `look_at_screen` returns a downscaled screenshot of the active window plus text from UI Automation and, outside Chromium-based apps, a short list of its controls the assistant can act on. If the Main model doesn't support images, it returns only the text. Screenshots are dropped from the thread when it is compacted.
- **Clipboard:** `clipboard_read` returns what is on the clipboard: text, an image (downscaled, dropped at compaction and left out when the Main model has no image support, like screenshots) or file paths, or says the clipboard is empty. Content a password manager marks as private is never returned. `clipboard_write` replaces the clipboard with text. `clipboard_edit` replaces one part of the clipboard text; when that part is missing or occurs more than once it fails and the clipboard stays as it was. With "Ask before running" on, writing and editing ask first and reading does not. The "now" line carries a clipboard note with kind and size only, for example "text, 640 characters", never the contents; the contents reach the model only when the assistant reads them. Outside Windows the tools report that the clipboard isn't available.
- **Clipboard history:** while Winku runs it keeps the last 20 text copies in memory, newest first, with the time of each, so "what I copied before this" works. `clipboard_read` with a list flag returns the history as index, age, length and a one-line preview; with an index it returns that entry in full, 0 being the latest text copy. Images and files are not kept. Copying the same text again moves it to the front. Content a password manager marks as private is never recorded. Winku's own clipboard use, the simulated copy that captures a selection and the paste-back of a result, is never recorded either. Text the assistant writes with `clipboard_write` or `clipboard_edit` is the user's clipboard and becomes the latest entry. Nothing is written to disk; the history is gone when Winku quits.
- **Chromium-based apps** (Chrome, Edge, VS Code, Slack, Teams and other Electron or WebView2 apps) switch on their full accessibility tree the first time anything reads them through UI Automation, and stay slower until they restart. Winku never reads them just to gather context: not for the now line, and not for `look_at_screen` when there is a screenshot. It reads them only when you ask it to operate the app.
- **Scheduled tasks:** Winku can wait. Asked to ("remind me in twenty minutes", "check that DM every couple of minutes and answer him", "tell me when the build fails"), the assistant schedules its own wakeups, the way Claude Code's `/loop` and Monitor do:
  - A **timer** runs a prompt once, at a time or after a delay.
  - A **loop** runs a prompt every interval (15 seconds at least), or is self-paced: each run picks the next delay, 1 to 60 minutes, or stops. Every run calls the model.
  - A **watch** runs a command in the background, and each line it prints wakes Winku with that line. Waiting costs no model calls.
  - A run is a normal turn in the current thread, marked `[scheduled: <name>]`. It starts only between turns, never mid-reply or while you are typing, and its reply opens the bubble under the pill without taking focus; it is spoken when the request that set it up was. A message you send during a run steers it.
  - Missed runs (the PC asleep, Winku busy or closed) collapse into one. A timer more than 10 minutes late is dropped. Loops run up to half their interval late (at most 30 minutes), so Winku doesn't call the provider on the hour. Loops and watches expire after 7 days with one last run. After a restart loops carry on, watches start their command again, and the conversation gets a one-line notice for each wakeup that was lost.
  - Limits: 50 tasks, 5 watches. Three failed runs in a row stop a task, with a notice. Scheduled runs obey "Ask before running" and wait for an answer rather than assuming yes; acting in another app always asks in a scheduled run unless that app is always allowed. A run can only reschedule or cancel itself. Settings > Schedules lists the tasks with a Cancel button.
  - Tasks run only while Winku is open: no OS scheduled tasks, no service, no cloud scheduler, no cron expressions.

## 8. Context, caching and history

- There is one thread, it survives restarts, and it lasts until you clear it.
- A message sent while a reply is running steers it: the model gets it as soon as its current step ends and carries on from there. Nothing already written is cut off; `Esc` still stops.
- **Request layout:** the system prompt comes first and stays the same for the whole thread. It holds the instructions, tools, the voice profiles and the memory block: About me, the profile, the goals, the recap and the list of note topics, as they were when the thread started. After that comes the conversation, which is only ever appended to. Notes recalled for a message ride at the end of that message, like the now line. This keeps provider prompt caching working.
- **Context size:** the Main model's context window is capped at 250k tokens by default, adjustable in Settings. A model with a smaller window uses its own.
- **Compaction:** pi auto-compacts at its default threshold, adjustable in Settings. The meter and the eyelids both show how full the context is.
- **Visuals at compaction:** a visual shrinks to its title in the model's copy of the thread, the way screenshots are dropped; the file and History keep the whole page.
- **Clear:** archives the session and starts a new one. Memory, About me and voice profiles survive.
- **History:** right-click > History lets you read and search archived sessions, and "Restore as current" brings one back after archiving the current session first.

## 9. Memory and voice

All of this is plain markdown under `%APPDATA%\winku\`, so you can edit it in any editor. The markdown is the memory; everything else is derived from it and rebuilt when it changes.

```
%APPDATA%\winku\
  settings.json
  about-me.md            yours; the assistant only reads it
  voice\casual.md        your voice profiles (rules + samples), chosen by active app
  voice\work.md
  memory\PROFILE.md      lasting facts about you, in every message
  memory\GOALS.md        what you are working toward, in every message
  memory\RECAP.md        what happened in the last thread, in every message
  memory\MEMORY.md       index of the topic files, for you to browse
  memory\<topic>.md      notes, dated sections; recalled when they relate to a message
  memory\threads.md      a recap of each past thread, recalled like notes
  tasks.json             scheduled tasks (section 7); never the output of a watch
  engine\                pi agent dir + sessions + the memory search index (internal)
  models\                downloaded STT/TTS models and the memory search model
```

- **Always known:** the memory block (About me, profile, goals, recap and the list of note topics) is in every request, in the frozen system prompt, so the assistant knows who you are on an ordinary question, not only when you ask about yourself. It is told to treat the block as things it already knows. The block stays small: the profile about 600 tokens, the goals and the recap about 300 each. When it must be cut, the recap goes first, then the goals, then the profile; About me is never cut.
- **Recall:** before each message goes to the model, Winku searches the notes and past-thread recaps for ones that relate to it, by meaning (a small local embedding model) and by keyword, favouring recent ones and ones marked important, and adds the best few (about 600 tokens at most) to the end of that message. A note already recalled since the last compaction isn't added again. Recall takes a few milliseconds and never waits longer than about a third of a second; if the search model isn't ready, keyword search alone is used. It can be turned off in Settings.
- **Search model:** bge-small-en-v1.5 (34 MB), downloaded the first time recall needs it and run by the shell on the speech engine's runtime. It loads when the bar opens and frees its memory after 3 idle minutes.
- **Writing memory:** the assistant writes memory on its own and when you ask it to "remember…": a fact for the profile, a goal, or a note under a topic. It can replace an outdated profile line or goal, or drop one, the same way. Each save shows a "Saved to memory: …" row with Undo, and the eyes do the "noted" blink. A new note can be recalled from the next message on.
- **Tidy:** when you clear the thread, or after about 10 quiet minutes with new messages, Winku reads the conversation since the last tidy with the Quick actions model and updates the profile and goals (adding, rewording and removing lines), adds notes worth keeping, and writes a recap of the thread. It runs in the background and never delays a reply. It can be turned off in Settings, and Settings can run it now. Notes are never deleted by it.
- **Voice profiles:** the assistant can only propose changes to a voice profile, which you Accept or Dismiss. "Learn from my edits" comes after v1.
- **Caching:** the profile, goals and recap reach the system prompt only after a clear or a compaction (or right after a tidy, while the new thread has no messages yet). Until then the transcript row and recall are how the model knows about new memory.
- **Settings > Memory and voice:** shows the profile, goals and recap for editing, lists the notes with Delete or shows them as a map of topics with related notes linked, has a message tester that shows what a message would carry without sending it, shows the search model, and has the recall and tidy switches.
- **Forget everything:** a separate Settings button that wipes `memory\` and the search index, after a confirmation.
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
- **Speech-to-text:** Moonshine base or Whisper base.en by default. Parakeet is an optional download. While you hold the talk key, the words heard so far show in the message box and are corrected as you go; releasing the key fills in the final transcription. Before the model has downloaded, the words only appear after release.
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
9. **Visuals:** the `show` tool, the sandboxed frame and its own origin, theme variables, the wide bubble and transcript, the Drawing eyes, the visuals folder and compaction.
