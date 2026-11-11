// Turning a keydown into a binding string like "Ctrl+Alt+Space" (the format settings.json uses).

const NAMED: Record<string, string> = {
	" ": "Space",
	Spacebar: "Space",
	ArrowUp: "Up",
	ArrowDown: "Down",
	ArrowLeft: "Left",
	ArrowRight: "Right",
	Escape: "Esc",
};

export function bindingFromEvent(event: KeyboardEvent): string | null {
	if (["Control", "Alt", "Shift", "Meta", "AltGraph"].includes(event.key)) return null;
	let key = NAMED[event.key] ?? event.key;
	if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
	else if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
	else if (key.length === 1) key = key.toUpperCase();
	const parts = [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Super", key];
	const binding = parts.filter(Boolean).join("+");
	// A global shortcut needs a modifier, except function keys like F13 (leader keys).
	if (!event.ctrlKey && !event.altKey && !event.metaKey && !/^F\d{1,2}$/.test(key)) return null;
	return binding;
}

/** Bindings used more than once. */
export function duplicates(bindings: string[]): Set<string> {
	const seen = new Set<string>();
	const dupes = new Set<string>();
	for (const b of bindings.map((b) => b.toLowerCase())) {
		if (seen.has(b)) dupes.add(b);
		seen.add(b);
	}
	return dupes;
}
