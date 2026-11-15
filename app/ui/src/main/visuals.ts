// Visuals in a reply (SPEC §3): where each one sits in the reply's text, and where its page loads
// from. The shell serves each saved page from Winku's own URL scheme (app/src-tauri/src/visuals.rs).
import type { VisualShown } from "../../../../engine/src/protocol.ts";

/** A visual the model put in the current reply with `show`. */
export interface ReplyVisual {
	/** The engine's visual_show Request, answered once with what the frame measured. */
	requestId: string;
	id: string;
	title: string;
	/** Where it sits: the length of the reply's text when it was shown. */
	at: number;
	answered?: boolean;
}

export type ReplyPart = { kind: "text"; text: string } | { kind: "visual"; visual: ReplyVisual };

/** The reply's text cut where its visuals go, in order. Empty text between them is left out. */
export function replyParts(text: string, visuals: readonly ReplyVisual[]): ReplyPart[] {
	const parts: ReplyPart[] = [];
	let from = 0;
	for (const visual of [...visuals].sort((a, b) => a.at - b.at)) {
		const at = Math.min(Math.max(visual.at, from), text.length);
		if (text.slice(from, at).trim()) parts.push({ kind: "text", text: text.slice(from, at) });
		parts.push({ kind: "visual", visual });
		from = at;
	}
	if (text.slice(from).trim()) parts.push({ kind: "text", text: text.slice(from) });
	return parts;
}

/** Tauri serves custom schemes as http://<scheme>.localhost on Windows, <scheme>://localhost elsewhere. */
export function visualUrl(id: string, windows = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows")): string {
	return windows ? `http://winku-visual.localhost/${id}.html` : `winku-visual://localhost/${id}.html`;
}

/** Every message a page's bridge may post to the frame's parent, and nothing else (SPEC §3: the
 * page's height, link and image clicks, Winku's keys). Keep in step with BRIDGE in visuals.rs.
 * Pages are untrusted: nothing here can send a message, run a tool or start a turn. */
export type BridgeMessage =
	| { winku: "visual"; kind: "height"; height: number }
	| { winku: "visual"; kind: "loaded"; height: number }
	| { winku: "visual"; kind: "error"; message: string }
	/** A link was clicked; the page didn't follow it. Only http(s) ever opens. */
	| { winku: "visual"; kind: "link"; href: string }
	/** The visual itself (an image, or anywhere that isn't a link or a control) was clicked. */
	| { winku: "visual"; kind: "click" }
	| ({ winku: "visual"; kind: "key" } & KeyPress);

export interface KeyPress {
	key: string;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
	meta: boolean;
}

/** Longer links are ignored rather than cut. */
const MAX_HREF = 2048;

export function isBridgeMessage(data: unknown): data is BridgeMessage {
	if (!data || typeof data !== "object") return false;
	const m = data as Record<string, unknown>;
	if (m.winku !== "visual") return false;
	switch (m.kind) {
		case "height":
		case "loaded":
			return typeof m.height === "number" && Number.isFinite(m.height);
		case "error":
			return typeof m.message === "string";
		case "link":
			return typeof m.href === "string" && m.href.length <= MAX_HREF;
		case "click":
			return true;
		case "key":
			return typeof m.key === "string" && m.key.length <= 32 && [m.ctrl, m.alt, m.shift, m.meta].every((b) => typeof b === "boolean");
		default:
			return false;
	}
}

/** What a key press does in Winku, wherever focus is (the bar, or a visual's frame). */
export type WinkuKey = "escape" | "transcript";

export function winkuKey(press: KeyPress): WinkuKey | null {
	if (press.key === "Escape") return "escape";
	if (press.key.toLowerCase() === "j" && press.ctrl && !press.alt && !press.shift) return "transcript";
	return null;
}

/** Only http(s) links leave a visual, for the default browser. */
export function isWebLink(href: string): boolean {
	return /^https?:\/\//i.test(href.trimStart()) && !/[\u0000-\u001f\u007f]/.test(href);
}

export type { VisualShown };
