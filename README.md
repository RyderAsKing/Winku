# Winku

A small desktop assistant that lives as a pair of glowing eyes at the edge of your screen. Press a key to type or hold it to talk. It answers in text or voice, can look at the window you're using, run things for you, and rewrite selected text in place. It keeps one conversation going until you clear it.

Winku is open source (MIT). There is no account and no telemetry. It talks only to the model provider you choose and, if you add a key, Brave Search.

## Install

Windows 10 and 11 only for now. Linux and macOS come later.

1. Download `Winku_<version>_x64-setup.exe` from the [latest release](https://github.com/RyderAsKing/Winku/releases/latest).
2. Run it. The installer isn't code-signed yet, so Windows SmartScreen may say it "protected your PC". Choose **More info**, then **Run anyway**.
3. The eyes appear at the edge of the screen. Press `Ctrl+Alt+Space` and connect a model: pick a provider, paste an API key, choose a model and press Test.

Winku updates itself from GitHub Releases. Each update is checked against Winku's signing key before it installs, and it installs when you quit or restart. You can switch this to "Tell me" or "Off" in Settings > App.

## Use it

| Keys | Does |
|---|---|
| tap `Ctrl+Alt+Space` | open or hide the bar |
| hold `Ctrl+Alt+Space` | talk; let go to send. Holding also stops Winku speaking |
| `Ctrl+Alt+1`–`5` | run an action on the selected text |
| `Ctrl+Alt+Q` | ask about the selected text |
| `Ctrl+Alt+S` | attach a screenshot of the current window |
| `Ctrl+Alt+X` | clear the conversation (Undo for 5 seconds) |
| `Ctrl+Alt+T` | change how hard the model thinks |
| `Esc` | stop the reply or the speech; press again to hide the bar |
| `Ctrl+J` | show or hide the whole conversation |

All keys can be changed in Settings. If `Ctrl+Alt` types characters on your keyboard layout (AltGr), Settings offers `Ctrl+Shift` instead. You can also set a leader key such as F13.

- **Actions:** select text in any app and press `Ctrl+Alt+1`. The defaults are Rewrite, Fix grammar, Shorter (each replaces the selection; `Ctrl+Z` in that app undoes it), Explain (shows in the bar) and Do it (runs it as a task with tools). You can edit all five.
- **Tools:** Winku can read and write files in your home folder, run PowerShell, open files, apps and web pages, read web pages and look at the window you were using. Turn on Settings > Tools > "Ask before running" to approve each change first.
- **Voice:** the first time you hold the talk key, Winku downloads a speech model (about 110 MB), with progress shown on the eyes. Speech is recognised on your computer and never sent anywhere. Replies are read aloud when you spoke, in a natural offline voice (Supertonic, an 85 MB download on first use; the Windows voice reads until it arrives, and stays available in Settings).
- **Memory:** Winku saves things worth remembering as plain markdown files, and each reply shows what it saved with an Undo. Settings > Memory and voice opens the folder, the "About me" file and your writing voice profiles.
- **Right-click the eyes** for Settings, History, Ask before running, Hide eyes, Pause listening and Quit.

## Your data

Everything lives in `%APPDATA%\winku`: settings, conversations and history, memory, voice profiles and downloaded speech models. API keys are kept in Windows Credential Manager, never in a file. Nothing is sent anywhere except to your model provider, and to Brave Search if you added a key.

## Build from source

You need [Bun](https://bun.sh) 1.4, Rust (stable) and, on Windows, the WebView2 runtime and the MSVC build tools. On Linux you also need Tauri's system packages plus `libasound2-dev`.

```sh
cd app
bun install
bun run dev        # builds the engine, then runs the app with hot reload
bun run build      # release build with the installer
```

`bun run ui:dev` serves only the UI in a browser, with a mock shell. `bun run screenshots` captures it. The tests:

```sh
cd engine && bun test                      # engine
cd app && bun run check && bun run test    # UI
cd app/src-tauri && cargo test             # shell
```

[docs/SPEC.md](docs/SPEC.md) describes what Winku does and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) how it is built.

## Releasing

1. Set the new version in `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml`, `app/package.json` and `engine/package.json`.
2. Merge that to `main`, then tag it and push the tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. The Release workflow builds the installer, signs the update, and publishes the GitHub Release with `latest.json`. Installed copies pick it up within six hours.

The update signing key's private half is the `TAURI_SIGNING_PRIVATE_KEY` secret, with `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Keep a backup somewhere safe. If it's lost, installed copies can't verify new updates and everyone has to reinstall by hand.

## License

[MIT](LICENSE)
