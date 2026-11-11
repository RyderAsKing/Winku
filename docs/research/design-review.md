# UI release review

Reviewed on 11 November 2026. Scores cover the browser-rendered UI at the specified desktop window sizes and at 1× and 2× density. They are design judgments, not automated accessibility certification. Overall: **7.3/10 before, 9/10 after**.

## Findings and results

| Area | Before | After | Concrete finding and change |
| --- | ---: | ---: | --- |
| Resting pill | 8 | 9 | Pointer activation worked, keyboard activation did not. Enter and Space now open the bar; focus stays visible. Kept the 140×84 frame. |
| Bar | 7 | 9 | Message focus had no visible indicator. Metadata could crowd the input. Added rounded focus, wrapping metadata, and a 432px height cap matching the shell. |
| Replies and streaming | 7 | 9 | Unbroken text could extend past the reply. Added containment and wrapping; preserved streaming and internal scrolling. |
| Tool rows | 6 | 9 | Faint text and clipped paths hid useful information. Brighter text and expandable rows reveal the full command. Many rows stay inside the reply scroller. |
| Permission | 7 | 9 | Three buttons crowded a bordered box inside the reply. Replaced the box with a divider; choices wrap and have 32px targets. Commands wrap. |
| Voice proposals | 7.5 | 9 | Small actions and nested preview treatment. Consistent buttons, simple divider, wrapping preview, visible summary focus. |
| Errors | 6 | 9 | Long endpoints escaped the layout; recovery action competed with the message. Long text and recovery actions now wrap. |
| Toasts | 8 | 9 | Long text could squeeze Undo. Text wraps and the action keeps its width and a larger target. |
| Attachment chips | 8 | 9 | Remove targets were tiny. Increased targets to 24px while keeping the compact chip. |
| Transcript | 7 | 9 | Faint summaries, truncated tool labels, hidden code-copy actions, narrow table columns. Added readable summaries, keyboard scroll access, visible copy, and local code/table scrolling. Removed nested user bubbles in favour of a simple rule. |
| Connect | 7 | 9 | Weak placeholders, missing focus, cramped credentials and footer. Named fields, deliberate controls, flexible preset rows and a separate status line. Custom connection stays within the shell height and scrolls. |
| Settings: Model | 7 | 9 | Unnamed Main/API-key inputs and wasted frame width. Explicit field names, full-width page, consistent controls. Tested custom provider and separate Quick model. |
| Settings: Conversation | 7.5 | 9 | Faint placeholder and inconsistent number/textarea focus. Shared contrast, caret, focus and field treatment. |
| Settings: Tools | 7 | 9 | Small native checks, cramped key form, weak disabled state. Deliberate accent checks, consistent buttons, stronger hints and explicit disabled treatment. |
| Settings: Speech | 7.5 | 9 | Mixed control heights, small checks and low-contrast hints. Aligned 32px controls and readable supporting text. |
| Settings: Memory and voice | 7.5 | 9 | App mapping form was cramped; disabled action unclear. Wider field column, consistent actions and disabled styling; preserved inline delete confirmation. |
| Settings: Actions | 7 | 9 | Output labels truncated; checkboxes small; prompt focus faint. Short output labels, larger checks, consistent prompt treatment, restrained dividers. |
| Settings: Keys | 7 | 9 | Capture trapped Tab. Tab now leaves capture, Escape cancels, pressed state is announced, warnings and focus are readable. |
| Settings: Eyes | 8 | 9 | Small checkbox and weak supporting text. Shared checkbox and text treatment; preserved the single visibility setting. |
| Settings: App | 8 | 9 | Mixed button heights and weak hints. Consistent controls, focus and update status text. |
| History | 6.5 | 9 | Title clipped, empty preview unexplained, errors silently looked empty, selection loads could race. Wrapping title, helpful empty/search states, loading/error feedback, guarded read results and restore cleanup. Selected entry is announced. |
| Eye expressions | 9 | 9 | Existing glossy shapes, glow, dark face and distinct poses already meet the design brief. Kept them. |

## Eyes, state by state

| State | Before | After | Assessment |
| --- | ---: | ---: | --- |
| Idle | 9 | 9 | Rounded glossy squares; resting pill is still. |
| Listening | 9 | 9 | Teal, open eyes; pulse only with the bar showing. |
| Thinking | 9 | 9 | Amber tilt and up-right gaze remain distinct. |
| Speaking | 9 | 9 | Lavender; bounce obeys visibility and reduced motion. |
| Happy | 9 | 9 | Legible closed arcs at pill and bar size. |
| Hearts | 9 | 9 | Clear heart shape; existing cooldown preserved. |
| Error | 9 | 9 | Coral slant and small tear; message also explains the failure. |
| Cleared | 9 | 9 | Bright eyes on a dark face, with no inverted face. |
| Sleeping | 9 | 9 | Still crescents; no breathing loop. |
| Noted | 9 | 9 | Existing brief blink; memory row also communicates the save. |
| Sad / surprised / pondering | 9 | 9 | Existing distinct mood poses retained. |
| Context lids / thinking tints / download | 9 | 9 | Gallery covers lid levels and tints; download fill stays legible. No black lid caps. |

## Shared rules

Body/hint text against the raised control background measures 15.73:1 for text, 8.00:1 for muted text and 6.52:1 for faint text. The latter was previously below AA. Selection uses white text on dark teal; caret uses the accent. Placeholder text is opaque and readable. Native selects and their option menus use the dark palette. Checkboxes use the same accent. Number inputs retain native steppers. Textareas retain resizing where appropriate. Disabled controls, hover, pressed and keyboard-focus states share rules across windows.

No icons, emoji, decorative glow or decorative animation were added. The eye glow remains. Reduced motion disables CSS animation and transitions; the existing controller gates eye motion. No shell commands, events, settings schema, engine or Rust code changed.

## Capture and verification

The screenshot runner now has 50 cases, each captured at desktop and high density. Original case names and mock hooks remain available. New cases cover every Settings section at 680×520, History empty/many/no matches, long transcript at 420×560, twelve tools, long error URL, custom Connect, keyboard focus, partial streaming, expanded proposal, custom Settings and separate Quick model. Disabled controls appear in Connect and Settings captures. Mock timestamps and archive fixtures are fixed. Streaming uses a paused browser clock.

Before and after PNGs are kept under `app/.screenshots/before/` and `app/.screenshots/after/`; they are ignored by git. Late-added fixture baselines used the original committed UI with the new deterministic mock fixtures, then restored the polished files. Each final capture was visually reviewed in labelled sheets, with detailed inspection of the stressed layouts.

Verification commands:

- `cd app && bun run check`
- `cd app && bun run test`
- `cd app && bun run motion-check`
- `cd app && bun run ui:build`
- `cd app && BASE_URL=http://localhost:5180 node scripts/ui-audit.mjs`

All checks passed: svelte-check reports 0 errors and 0 warnings; 16 unit tests pass; all eight motion assertions pass; the production build and browser audit pass.

The extra browser audit checks keyboard pill activation, escape from hotkey capture with Tab, named model fields, long-error containment, transcript width, local code scrolling, History width, and text contrast.

## Kept and limits

Kept the eye artwork, glow, palette by state, cooldowns, motion controller, native select behaviour, shell sizes, single-column Settings structure, and the existing conversation/actions flow. These already fit the spec or belong to the shell contract. Code blocks retain an internal scrolling box because preserving code formatting is useful.

The external design reference returned HTTP 502 through both web access and a direct fetch. Eye review therefore uses SPEC §4, the owner's supplied description and the existing gallery. These scores apply to browser rendering. Windows WebView2/native window integration, screen-reader announcements and actual process idle CPU still need platform validation; the motion assertions pass but do not measure Windows CPU. No visual issue found in the reviewed browser cases remains below 9/10.
