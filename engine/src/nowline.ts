// The "now" line: what the user was looking at, appended to the end of the user message
// (never the system prompt, so the prompt cache keeps hitting).
import type { NowLine } from "./protocol.ts";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unescape = (s: string) =>
	s.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

/** `\n\n<now app="…" window="…">selection</now>`, or "" when there is nothing to say. */
export function formatNow(now: NowLine | undefined): string {
	if (!now) return "";
	const attrs = [
		now.app ? ` app="${escape(now.app)}"` : "",
		now.windowTitle ? ` window="${escape(now.windowTitle)}"` : "",
	].join("");
	const selection = now.selection ? escape(now.selection) : "";
	if (!attrs && !selection) return "";
	return `\n\n<now${attrs}>${selection}</now>`;
}

const TRAILING_NOW = /\n\n<now((?: [a-z]+="[^"]*")*)>([\s\S]*)<\/now>$/;

/** Split a stored user message back into the typed text and its now line. */
export function parseNow(text: string): { text: string; now?: NowLine } {
	const match = TRAILING_NOW.exec(text);
	if (!match) return { text };
	const now: NowLine = {};
	for (const [, key, value] of (match[1] ?? "").matchAll(/ ([a-z]+)="([^"]*)"/g)) {
		if (key === "app") now.app = unescape(value ?? "");
		if (key === "window") now.windowTitle = unescape(value ?? "");
	}
	if (match[2]) now.selection = unescape(match[2]);
	return { text: text.slice(0, match.index), now };
}
