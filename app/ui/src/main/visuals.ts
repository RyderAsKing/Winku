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

/** What the page's bridge posts to the frame's parent. Keep in step with BRIDGE in visuals.rs. */
export type BridgeMessage =
	| { winku: "visual"; kind: "height"; height: number }
	| { winku: "visual"; kind: "loaded"; height: number }
	| { winku: "visual"; kind: "error"; message: string };

export function isBridgeMessage(data: unknown): data is BridgeMessage {
	if (!data || typeof data !== "object") return false;
	const m = data as Record<string, unknown>;
	if (m.winku !== "visual") return false;
	if (m.kind === "height" || m.kind === "loaded") return typeof m.height === "number" && Number.isFinite(m.height);
	return m.kind === "error" && typeof m.message === "string";
}

export type { VisualShown };
