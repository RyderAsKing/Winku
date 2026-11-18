# Contributing to Winku

Thanks for helping. Winku is a small project with one maintainer, so here is how to make your time count.

## Issues first

- **Bugs.** [Open a bug report](https://github.com/RyderAsKing/Winku/issues/new?template=bug.yml). The Winku version (shown at the bottom of Settings), your Windows version (or Linux distribution, desktop, and X11 or Wayland) and the steps to make it happen again matter most.
- **Ideas.** [Open a feature idea](https://github.com/RyderAsKing/Winku/issues/new?template=idea.yml). [docs/SPEC.md](docs/SPEC.md) decides what Winku does, so an idea that changes it gets discussed before anyone writes code.
- **Pull requests.** Open an issue first and wait until we agree on the change. A PR that arrives without one may be closed, however good the code is, because it can clash with plans you couldn't see.
- **Security problems** go through the private route in [SECURITY.md](SECURITY.md), never a public issue.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Build from source

You need [Bun](https://bun.sh) 1.4, Rust (stable) and, on Windows, the WebView2 runtime and the MSVC build tools. On Linux you also need Tauri's system packages plus `libasound2-dev`:

```sh
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev libdbus-1-dev libasound2-dev
```

The Linux OS layer is `app/src-tauri/src/platform/linux.rs`, on X11 ([ADR 0003](docs/adr/0003-linux-runs-on-x11.md)). Try it in an X11 session, or in WSLg on Windows, which is an XWayland display. In WSLg an X window has focus only after you click it, and only then do the hotkeys reach Winku. Computer use doesn't work in WSLg: agent-desktop lists windows through `_NET_CLIENT_LIST`, which WSLg's window manager doesn't publish. Keep the checkout on the Linux file system (not under `/mnt`), or `bun install` and the build crawl.

```sh
cd app
bun install
bun run dev        # builds the engine, then runs the app with hot reload
bun run build      # release build with the installer
```

`bun run ui:dev` serves only the UI in a browser, with a mock shell. `bun run screenshots` captures it.

## Tests

```sh
cd engine && bun test                      # engine
cd app && bun run check && bun run test    # UI
cd app/src-tauri && cargo test             # shell
```

CI runs all three on every pull request.

## Where things are

- [docs/SPEC.md](docs/SPEC.md) describes what Winku does, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) how it's built.
- [GLOSSARY.md](GLOSSARY.md) has the words the docs and code use, such as eyes, bar, thread and task. Please use them in issues and PRs too.
- [docs/brand/BRAND.md](docs/brand/BRAND.md) covers the logo, colours and how Winku's text sounds.
- [docs/RELEASING.md](docs/RELEASING.md) is for the maintainer.
