# Your data

There is no account and no telemetry. Winku talks only to the model provider you choose and, if you add a key, Brave Search.

- **Where it lives.** Everything is in `%APPDATA%\winku`: settings, conversations and history, memory, voice profiles and downloaded speech models.
- **API keys** are kept in Windows Credential Manager, never in a file.
- **Speech** is recognised on your computer and never leaves it. Replies are read aloud by an offline voice.
- **What the model sees.** Each message you send carries a short note: the app and window title you're in, the text you have selected, and the kind and size of what's on the clipboard (not its contents). A screenshot or the clipboard's contents go only when you attach them or when Winku looks at them for something you asked.
- **Clipboard history** of your last 20 text copies is kept in memory while Winku runs, never on disk. Content a password manager marks as private is never kept or read.
- **Updates** are downloaded from GitHub Releases.

Found a security problem? Please report it privately, as [SECURITY.md](../SECURITY.md) explains.
