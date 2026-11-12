// What the keys do, for the hints shown while the hotkey prefix is held (SPEC §5).
import type { Settings } from "../lib/settings.ts";

export interface Hint {
	/** The key to press after the prefix, as written in the binding ("Space", "1", "Q"). */
	key: string;
	label: string;
}

/** The key after "Ctrl+Alt+", or null for a binding that the prefix doesn't start. A leader key
 *  replaces Ctrl+Alt in exactly these bindings, so the same list works with one. */
export function afterPrefix(binding: string): string | null {
	const match = /^ctrl\+alt\+([^+]+)$/i.exec(binding.trim());
	return match?.[1] ? match[1] : null;
}

/** Actions first (slots 1–5), then the rest, each list in the order Settings shows it. */
export function hintsFor(settings: Pick<Settings, "hotkeys" | "actions">): { actions: Hint[]; other: Hint[] } {
	const h = settings.hotkeys;
	const hint = (binding: string, label: string): Hint[] => {
		const key = afterPrefix(binding);
		return key && label.trim() ? [{ key, label: label.trim() }] : [];
	};
	return {
		actions: settings.actions.flatMap((action, i) => hint(h.actions[i] ?? "", action.name)),
		other: [
			...hint(h.summon, "Open, or hold to talk"),
			...hint(h.askSelection, "Ask about the selection"),
			...hint(h.screenshot, "Attach a screenshot"),
			...hint(h.clear, "Clear the conversation"),
			...hint(h.cycleThinking, "Thinking level"),
		],
	};
}
