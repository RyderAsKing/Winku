# Using Winku

## Keys

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
| `Ctrl+J` | show or hide the transcript, the whole conversation |

You can change every key in Settings. If `Ctrl+Alt` types characters on your keyboard layout (AltGr), Settings offers `Ctrl+Shift` instead. You can also set a leader key such as F13.

## The transcript

Winku keeps one conversation going until you clear it. The bubble under the bar shows the latest reply; scroll up over it, or press `Ctrl+J`, to see the whole thread.

<p align="center">
  <img src="media/transcript.png" alt="The transcript open under the bar: a question, a PowerShell command Winku ran, its answer with a code block, a saved memory with Undo, and a thank-you." width="440">
</p>

## Actions

Select text in any app and press `Ctrl+Alt+1`. The defaults are Rewrite, Fix grammar, Shorter (each replaces the selection, and `Ctrl+Z` in that app undoes it), Explain (shows in the bar) and Do it (runs it as a task with tools). You can edit all five in Settings > Actions.

## Tools

Winku can read and write files in your home folder, run PowerShell, open files, apps and web pages, read web pages and look at the window you were using. Turn on Settings > Tools > "Ask before running" to approve each change first.

## Voice

The first time you hold the talk key, Winku downloads a speech model of about 110 MB and shows the progress on the eyes. Your speech is recognised on your computer and never leaves it.

When you spoke, Winku reads the reply aloud in a natural offline voice (Supertonic, an 85 MB download on first use). The Windows voice reads until Supertonic arrives, and stays available in Settings.

## Memory

Winku saves things worth remembering as plain markdown files, and each reply shows what it saved, with an Undo. Settings > Memory and voice opens the folder, the "About me" file and your writing voice profiles.

## The right-click menu

Right-click the eyes for Settings, History, Ask before running, Hide eyes, Pause listening and Quit.

## Updates

Winku updates itself from GitHub Releases. It checks each update against Winku's signing key, then installs it when you quit or restart. You can switch this to "Tell me" or "Off" in Settings > App.
