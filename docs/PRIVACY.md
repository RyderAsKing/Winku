# Your data

There is no account and no telemetry. Winku talks only to the model provider you choose and, if you add a key, Brave Search.

- **Where it lives.** Everything is in `%APPDATA%\winku` on Windows, `~/.local/share/winku` on Linux and `~/Library/Application Support/winku` on macOS: settings, conversations and history, memory, voice profiles and downloaded speech and search models.
- **API keys** are kept in Windows Credential Manager, on Linux in the Secret Service (GNOME Keyring or KWallet), and on macOS in the login Keychain, never in a file.
- **Speech** is recognised on your computer and never leaves it. Replies are read aloud by an offline voice.
- **What the model sees.** Each message you send carries a short note: the app and window title you're in, the text you have selected, and the kind and size of what's on the clipboard (not its contents). A screenshot or the clipboard's contents go only when you attach them or when Winku looks at them for something you asked.
- **Memory** is plain markdown files you can read, edit or delete; Settings > Memory and voice shows it and has Forget everything. Your profile, goals and the last recap go with every message, and notes that relate to a message go with that message. The search that picks those notes runs on your computer. Keeping memory up to date reads your conversation with the Quick actions model you chose, so it goes to the same provider as the conversation itself. Both can be turned off in Settings.
- **Clipboard history** of your last 20 text copies is kept in memory while Winku runs, never on disk. Content a password manager marks as private is never kept or read. On Linux, when Winku puts your clipboard back after reading a selection or pasting, it adds KDE's password-manager mark, and on macOS the transient mark, so clipboard managers that honour them don't record the copy twice.
- **Updates** are downloaded from GitHub Releases, speech models from GitHub too, and the memory search model from Hugging Face. Each is a plain download of a pinned file, checked against its known checksum; nothing about you is sent.
- **Visuals.** A visual the assistant draws can load pictures or scripts from the web, the way a web page does. Nothing about you is sent with them.

Found a security problem? Please report it privately, as [SECURITY.md](../SECURITY.md) explains.
