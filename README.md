<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-light.svg">
    <img src="docs/brand/lockup-dark.svg" alt="Winku" width="360">
  </picture>
</p>

<p align="center">A desktop assistant that lives as a pair of eyes at the edge of your screen.</p>

<p align="center">
  <a href="https://github.com/RyderAsKing/Winku/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/RyderAsKing/Winku?color=5EF6F0&labelColor=0C0E13"></a>
  <img alt="Windows 10 and 11, Linux" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011%20%7C%20Linux-5EF6F0?labelColor=0C0E13">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/RyderAsKing/Winku?color=5EF6F0&labelColor=0C0E13"></a>
  <a href="https://github.com/RyderAsKing/Winku/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/RyderAsKing/Winku/actions/workflows/ci.yml/badge.svg"></a>
</p>

Press a key to type, or hold it to talk. Winku answers in text or out loud. It can look at the window you're using, run things for you, and rewrite selected text in place. It keeps one conversation going until you clear it.

There is no account and no telemetry. Winku talks only to the model provider you choose and, if you add a key, Brave Search.

> [!NOTE]
> Winku is early: version 0.x, and the Windows installer isn't code-signed yet. Expect rough edges, and please [report them](https://github.com/RyderAsKing/Winku/issues/new/choose).

## Install

Windows 10 and 11, and Linux (x86_64). macOS comes later.

**Windows**

1. Download `Winku_<version>_x64-setup.exe` from the [latest release](https://github.com/RyderAsKing/Winku/releases/latest).
2. Run it. Because the installer isn't signed, Windows SmartScreen may say it "protected your PC". Choose **More info**, then **Run anyway**.
3. The eyes appear at the edge of the screen. Press `Ctrl+Alt+Space` and connect a model: pick a provider, paste an API key, choose a model and press Test.

**Linux**

1. From the [latest release](https://github.com/RyderAsKing/Winku/releases/latest), download the `.deb` (Debian, Ubuntu, Mint), the `.rpm` (Fedora, openSUSE) or the `.AppImage` (any distribution with glibc 2.35 or newer).
2. Install the package, or make the AppImage executable (`chmod +x Winku_*.AppImage`) and run it.
3. Press `Ctrl+Alt+Space` and connect a model, as on Windows.

Winku on Linux works best in an **X11 session**. On Wayland (the default on GNOME and KDE Plasma) it runs through XWayland and can only see apps that do too. With a native Wayland app in front it can't read the selection, paste back or take a screenshot, and on GNOME the hotkeys don't fire. [Using Winku](docs/USING.md#linux) has the details.

## Use it

- Tap `Ctrl+Alt+Space` to open the bar, or hold it to talk.
- Select text anywhere and press `Ctrl+Alt+1` to rewrite it in place.
- Press `Esc` to stop, and again to hide the bar.

The rest is in the docs:

- [Using Winku](docs/USING.md): every key, actions, tools, voice, memory and updates
- [The eyes](docs/EYES.md): what each look means
- [Your data](docs/PRIVACY.md): what stays on your computer and what goes to your model provider

## Contributing

Bug reports and ideas are welcome in [Issues](https://github.com/RyderAsKing/Winku/issues/new/choose). For a pull request, open an issue first so we can agree on the change. [CONTRIBUTING.md](CONTRIBUTING.md) covers building from source and the tests. Security problems go through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Winku bundles [agent-desktop](https://github.com/vercel-labs/agent-desktop) (Apache-2.0); its licence is installed alongside the app. The wordmark is set in [Nunito](https://github.com/googlefonts/nunito) (SIL Open Font License).
