# macOS ships ad-hoc signed, without a Developer ID, and untested by hand

Winku has a macOS build: an app for Apple Silicon and one for Intel, each in a `.dmg` on the release. Nobody on the team has a Mac or an Apple Developer account. So the apps are signed ad hoc (`signingIdentity: "-"` in `tauri.macos.conf.json`): signed, but by no one Apple knows. They aren't notarized and don't use the hardened runtime. CI's macOS job is the only Mac that runs Winku. It builds the shell, runs clippy and the tests, bundles the app and keeps it running for half a minute. Nothing there clicks, types or grants a permission.

The OS layer is `platform/macos.rs`. It covers the same functions as `windows.rs` and `linux.rs`, using the APIs a Mac app normally uses:

- **The window list** (`CGWindowListCopyWindowInfo`) for the app in front, its window, process and bounds.
- **Quartz events** for Cmd+C and Cmd+V, and for the hotkey hints (a listen-only event tap).
- **The Accessibility API** for the selected text.
- **NSPasteboard** for the clipboard.
- **The `screencapture` tool** for window captures. Quartz's own window capture is deprecated and missing from current SDKs.

Winku places its own window through Tauri's calls: `window::handle` returns `None` on macOS.

## Considered options

- **Wait until someone has a Mac and an Apple Developer ID.** A Developer ID costs a yearly fee. Notarizing needs that account in CI. Waiting would leave Mac users with nothing, when most of the shell is portable already. The code is written against documented APIs and type-checked for both Mac targets, so it can ship as an unsigned preview.
- **Ship no binary, only "build it yourself".** Building needs Rust, Bun and Xcode's command line tools, and gives the same unsigned app. A prebuilt one with clear "open it anyway" steps helps more people, and anyone who wants to can still build from source.
- **Leave it unsigned altogether.** Apple Silicon Macs won't run an arm64 binary that has no signature at all. Ad-hoc signing is the least that runs.
- **Hardened runtime on.** It only matters for notarization, which we can't do. Turned on, it would also need entitlements for the Bun-compiled engine (JIT) and the microphone, or those would fail at run time.

## Consequences

- macOS quarantines the downloaded app and blocks it at first. On Apple Silicon it often says the app "is damaged", and on macOS 15 right-click > Open no longer gets past it. The release notes and the README give `xattr -dr com.apple.quarantine /Applications/Winku.app` as the main step, with **Open Anyway** in System Settings > Privacy & Security as the other way, and building from source as the third.
- macOS ties privacy permissions (Accessibility, Screen Recording, Input Monitoring, Microphone) to the app's code signature. An ad-hoc signature changes with every build, so the grants stop working after each update. Updates on macOS therefore default to "Tell me" rather than installing on their own, and USING.md says how to add Winku back in System Settings.
- Without Accessibility, Winku can't read the selection, paste a result back or click for computer use. Without Screen Recording, window titles and screenshots are missing. Without Input Monitoring, there are no hotkey hints. Each of these quietly does less; the rest keeps working.
- Bugs that only a real Mac shows (focus after the bar opens, paste-back timing, how the transparent window takes clicks, keyboard layouts other than US) will come from users. The bug template asks for the macOS version and the Mac's chip.
- With a Developer ID later, the change is the signing identity, notarization in the release job, and the hardened runtime with the entitlements above. Permissions would then survive updates.
