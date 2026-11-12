// The "now" line: what the user was looking at, appended to the end of the user message
// (never the system prompt, so the prompt cache keeps hitting).
import type { NowLine, SpeechLength } from "./protocol.ts";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unescape = (s: string) =>
	s.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

/**
 * `\n\n<now app="…" window="…" clipboard="text, 120 words" spoken="yes" speak="enough">selection</now>`, or "" when there is
 * nothing to say. `speak` asks for a <say> block of that length (prompt.ts).
 */
export function formatNow(now: NowLine | undefined, spoken = false, speak?: SpeechLength): string {
	if (!now && !spoken && !speak) return "";
	const attrs = [
		now?.app ? ` app="${escape(now.app)}"` : "",
		now?.windowTitle ? ` window="${escape(now.windowTitle)}"` : "",
		now?.clipboard ? ` clipboard="${escape(now.clipboard)}"` : "",
		spoken ? ` spoken="yes"` : "",
		speak ? ` speak="${speak}"` : "",
	].join("");
	const selection = now?.selection ? escape(now.selection) : "";
	if (!attrs && !selection) return "";
	return `\n\n<now${attrs}>${selection}</now>`;
}

const TRAILING_NOW = /\n\n<now((?: [a-z]+="[^"]*")*)>([\s\S]*)<\/now>$/;

/** Split a stored user message back into the typed text and its now line. */
export function parseNow(text: string): { text: string; now?: NowLine; spoken?: true } {
	const match = TRAILING_NOW.exec(text);
	if (!match) return { text };
	const now: NowLine = {};
	let spoken = false;
	for (const [, key, value] of (match[1] ?? "").matchAll(/ ([a-z]+)="([^"]*)"/g)) {
		if (key === "app") now.app = unescape(value ?? "");
		if (key === "window") now.windowTitle = unescape(value ?? "");
		if (key === "clipboard") now.clipboard = unescape(value ?? "");
		if (key === "spoken") spoken = value === "yes";
	}
	if (match[2]) now.selection = unescape(match[2]);
	const rest = { text: text.slice(0, match.index), ...(Object.keys(now).length ? { now } : {}) };
	return spoken ? { ...rest, spoken: true } : rest;
}
