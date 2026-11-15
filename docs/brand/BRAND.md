# Winku brand

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="lockup-light.svg">
  <img src="lockup-dark.svg" alt="Winku" width="320">
</picture>

Winku's brand is the eyes. The mark is the resting eyes as they look on screen, the colours come from the eye states, and the words stay plain so the eyes can carry the personality.

## The mark

[mark.svg](mark.svg) is the resting eyes at the large size: the dark pill with two glossy, rounded-square eyes in the idle tint. Its geometry comes straight from `app/ui/src/lib/eyes/Eyes.svelte`, scaled up, so the logo and the app always match. If the eyes change shape, change the mark too.

- Use the mark as it is. Don't recolour the eyes, swap in another eye state, add an outline or put it in a box.
- The face is always dark, on light and dark backgrounds alike, just as in the app.
- Leave clear space around it of at least a quarter of the pill's height.
- The app icons in `app/src-tauri/icons/` are rendered from this file.

## The wordmark

"Winku", with a capital W, set in [Nunito](https://github.com/googlefonts/nunito) ExtraBold (800) with the font's default kerning and outlined to paths. It comes in two inks:

| File | Use on |
|---|---|
| [wordmark-light.svg](wordmark-light.svg), [lockup-light.svg](lockup-light.svg) | dark backgrounds |
| [wordmark-dark.svg](wordmark-dark.svg), [lockup-dark.svg](lockup-dark.svg) | light backgrounds |

The lockup is the mark followed by the wordmark, whose cap height is a little over half the pill's height. Prefer the lockup. Use the mark alone where space is tight or the name is already nearby, such as app icons and avatars.

In text, write "Winku", never "WINKU" or "winku" (except in file paths and code).

Nunito is only for the wordmark and brand pictures such as the social card. The app's own text uses the system font (Segoe UI Variable on Windows). Nunito's licence is in [fonts/OFL.txt](fonts/OFL.txt).

## Colours

| | Hex | Where |
|---|---|---|
| Winku cyan | `#5EF6F0` | the brand colour: idle eyes at the default thinking level, the app's accent |
| Face, top | `#181B22` | the pill's face gradient |
| Face, bottom | `#07080C` | |
| Panel | `#0C0E13` | backgrounds, the dark wordmark ink |
| Text | `#F4F1EA` | text on dark, the light wordmark ink |
| Muted | `#AAAEB9` | secondary text |

The eye states have their own colours: listening teal `#4CFFE3`, thinking amber `#FFD56A`, speaking lavender `#C9B8FF` and error coral `#FF8B82`. They belong to the states. Use them to show a state, never as general brand colours.

The eyes glow. Nothing else does: no glow, gradients or sparkles on text, buttons or backgrounds.

## Voice

Winku's text is warm but plain. The eyes are where the charm lives, so the words don't need to try.

- Say what Winku does, with keys and numbers: "Hold `Ctrl+Alt+Space` to talk" rather than "Chat naturally with your new AI buddy".
- Short sentences, everyday words, and no exclamation marks.
- No emoji, in the app or in the docs.
- Don't call Winku "cute" or describe its personality. Show it in a picture or a GIF instead.
- Be honest about limits: Windows only for now, unsigned installer, early version.
- Use the words in [GLOSSARY.md](../../GLOSSARY.md): the eyes, the bar, the bubble, the transcript, the thread. "Pill" is only the name of the shape, not something to call Winku in user-facing text.

Tagline: **A desktop assistant that lives as a pair of eyes at the edge of your screen.**

## Files and how to rebuild them

The SVGs are the sources. After editing them, run this from `app/`:

```sh
bun run brand
```

It renders [mark.png](mark.png) (1024 px), the social card [social-card.png](social-card.png) (1280×640, from [social-card.html](social-card.html)) and the app icons in `app/src-tauri/icons/`.

The README's demo GIF and pictures in `docs/media/` come from the UI running on the mock shell:

```sh
bun run ui:dev          # in one terminal
bun run readme-media    # in another; needs ffmpeg
```

After changing the social card, upload `social-card.png` in the repository's Settings > General > Social preview. GitHub has no API for it.
