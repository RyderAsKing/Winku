# Linux runs on X11, and on Wayland through XWayland

Winku on Linux talks to an X server, never to Wayland directly. The shell asks GTK for its X11 backend at startup (`platform::force_x11_backend`), so on a Wayland desktop it runs as an XWayland client. Everything the Windows shell does with Win32 calls is done with X11 requests (`platform/linux.rs`, through x11rb). Winku places its own window and keeps it above others; it makes the transparent parts of the window click-through (the Shape extension's input region); it reads the active window, its title and process; it sends Ctrl+C and Ctrl+V (XTest); it captures the window from the screen; it owns and reads the clipboard; and it watches for fullscreen windows. The global hotkeys come from global-hotkey, which grabs keys on X11 only. The hotkey hints read XInput 2 raw key events.

On an X11 session every feature works. On a Wayland session Winku itself works, but it can only see, read from and type into apps that also run through XWayland. Apps that run natively on Wayland (most GTK 4 and Qt 6 apps, and Firefox and Chromium when set to Wayland) are invisible to X11 clients, by design. With one of those in front, Winku knows no foreground app, can't read its selection, can't paste back into it, and can't take a screenshot of it. Computer use is the exception: agent-desktop talks to apps through AT-SPI, which works on both.

## Considered options

- **Native Wayland.** Wayland gives an ordinary app no way to place its own window, stay above other windows, read another app's window or selection, send keys to it, or register global shortcuts. Some of this exists as portals (GlobalShortcuts, RemoteDesktop for input, ScreenCast) or as compositor extensions (wlr-layer-shell, which GNOME doesn't implement). Each one needs a permission prompt, works on some desktops and not others, and covers only part of what Winku needs. That would be a second shell for one desktop at a time.
- **Shell out to xdotool, xclip and similar tools.** Less code, but each call starts a process, the tools have to be installed, and xclip can't serve a clipboard that Winku has to keep and restore. x11rb is pure Rust and adds no system library.

## Consequences

- The Linux docs say plainly that a Wayland desktop limits Winku to XWayland apps, and they tell the user to pick an X11 session for the full feature set.
- On GNOME under Wayland, XWayland only delivers a grabbed key while an X11 window has focus, so the hotkeys don't fire while a native Wayland app is in front. KDE Plasma forwards them when "Allow legacy X11 apps to read keystrokes" is set.
- X11 has no clipboard store. What Winku copies stays available only while Winku runs, unless a clipboard manager keeps it, which most desktops have.
- The transparent stage needs a compositing window manager. All the major desktops have one.
- If the native-Wayland pieces become portable later (for example a layer-shell protocol GNOME also ships), this can be revisited for the window. The selection and paste-back would still need X11 or AT-SPI.
