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

/** What the focused app said about its selection when the hold began (SPEC §5). "unknown": the
 *  query was off, not answered in time, or the app has no text to ask about. */
export type SelectionState = "unknown" | "none" | "read-only" | "editable";

/** The `selection` field of a `hotkey_hint` event: absent is unknown, null is nothing selected. */
export function selectionState(selection: { editable: boolean } | null | undefined): SelectionState {
	if (selection === undefined) return "unknown";
	if (selection === null) return "none";
	return selection.editable ? "editable" : "read-only";
}

/** Actions first (slots 1–5), then the rest, each list in the order Settings shows it. With text
 *  selected only the keys that act on it; with nothing selected only the general keys. When that
 *  leaves nothing, the full list. */
export function hintsFor(
	settings: Pick<Settings, "hotkeys" | "actions">,
	selection: SelectionState = "unknown",
): { actions: Hint[]; other: Hint[] } {
	const h = settings.hotkeys;
	const hint = (binding: string, label: string): Hint[] => {
		const key = afterPrefix(binding);
		return key && label.trim() ? [{ key, label: label.trim() }] : [];
	};
	const actions = (withReplace: boolean) =>
		settings.actions.flatMap((spec, i) =>
			withReplace || spec.output !== "replace" ? hint(h.actions[i] ?? "", spec.name) : [],
		);
	const ask = hint(h.askSelection, "Ask about the selection");
	const general = [
		...hint(h.summon, "Open, or hold to talk"),
		...hint(h.screenshot, "Attach a screenshot"),
		...hint(h.clear, "Clear the conversation"),
		...hint(h.cycleThinking, "Thinking level"),
	];
	const full = { actions: actions(true), other: [...general.slice(0, 1), ...ask, ...general.slice(1)] };
	if (selection === "unknown") return full;
	const lists =
		selection === "none"
			? { actions: [], other: general }
			: { actions: actions(selection === "editable"), other: ask };
	return lists.actions.length + lists.other.length > 0 ? lists : full;
}
