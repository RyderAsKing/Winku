// show: the assistant puts a visual (a small HTML page) into its reply (SPEC §3 Visuals, §7 Showing).
// The page is saved as visuals\<id>.html in the data folder; the main window shows it in a
// sandboxed frame served from the visual's own URL scheme and reports what the frame measured.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { VisualShown } from "../protocol.ts";
import { RequestTimeout, type ShellRequests } from "../requests.ts";
import { inlineLocalImages } from "./visual-images.ts";

/** How long the frame has to load the page and report its height. */
export const SHOW_TIMEOUT_MS = 20_000;

/** What the thread keeps of a visual: the page itself lives in its file. */
export interface VisualRef {
	id: string;
	title: string;
	/** The broken visual this one replaced in place (SPEC §7 Showing). */
	replaces?: string;
}

export interface ShowDeps {
	requests: ShellRequests;
	/** Winku's data folder; visuals go in its visuals\ folder. */
	dataDir: () => string;
	replyId: () => string | undefined;
}

/** The largest page `show` accepts. */
export const MAX_PAGE_BYTES = 512 * 1024;

/** Why a page can't be shown, written for the model, or undefined if it is fine. */
export function refusePage(html: string): string | undefined {
	if (Buffer.byteLength(html, "utf8") > MAX_PAGE_BYTES) {
		return `This page is over 512 KB. Make it smaller: draw less, drop inline data and pictures, or load a library from an https URL instead of pasting it in.`;
	}
	const unit = /\d(?:\.\d+)?\s*[dls]?vh\b/i.exec(html);
	if (unit) {
		return `This page uses a viewport height unit ("${unit[0].trim()}"). The frame grows to fit the page, so anything sized by the viewport height gets no stable size. Use pixels, rem, % of width or aspect-ratio instead, and don't use vh, dvh, svh or lvh anywhere.`;
	}
	return undefined;
}

export function visualPath(dataDir: string, id: string): string {
	return join(dataDir, "visuals", `${id}.html`);
}

/** The tool result: what the frame measured, so a broken page can be fixed in the next step. */
export function describeShown(ref: VisualRef, shown: VisualShown): string {
	const lines = [
		`${ref.replaces ? `Replaced visual ${ref.replaces} with` : "Showed"} "${ref.title}" (visual ${ref.id}) in the reply. The frame measured ${Math.round(shown.height)} px tall.`,
	];
	if (shown.errors.length) lines.push("Script errors:", ...shown.errors.map((e) => `- ${e}`));
	else lines.push("No script errors.");
	return lines.join("\n");
}

export const SHOW_INSTRUCTIONS = [
	"Draw a visual into your reply: a small HTML page, such as a chart, a table, a diagram or a small interactive widget, shown where you call this, between the text before and after it.",
	"When to draw: only when showing beats telling, such as numbers to compare, a shape to see or something to try. Most replies stay text; never draw for decoration or to restate what you said.",
	"Layout: write one complete page with its own <style> and <script>; it may load scripts and pictures from https URLs (no fetch or network calls from the page). It sits in a small translucent bubble, so keep it compact (about 560 px wide at most), with a short caption instead of a big heading, and let it grow to fit its content. Never size anything by the viewport: vh, dvh, svh and lvh units are refused. Pages over 512 KB are refused too. To show a local picture, give its absolute path as an <img> src; it is written into the page, and must be a real image under 2 MB.",
	"Look: every page already has Winku's palette as CSS variables (--text, --muted, --faint, --accent #5ef6f0, --hot #ffd56a, --error, --line, --panel, --font, --mono), no background (leave it that way; the bubble shows through), light text on dark, and a 4 px body margin. Use the variables instead of your own colours and fonts.",
	"House style: draw charts and diagrams as dot matrices, like Winku's own dot field, and not with smooth bars, lines or gradients. There are no faint unlit dots. A bar chart needs only HTML: <figure class=\"w-chart\"><figcaption>Build time by day</figcaption><div class=\"w-bars\"><div class=\"w-bar\" style=\"--rows:6\"><span class=\"w-value\">6s</span><i class=\"w-dots\"></i><span class=\"w-label\">Mon</span></div><div class=\"w-bar hot\" style=\"--rows:12\">...</div></div></figure>. --rows is a bar's height in dots (keep the tallest at about 14), --cols its width in dots (default 7), and class hot highlights the one bar that matters. The bars' dots rise once when the chart lands, then stay still. For other charts in SVG, draw circles r=2.3 on an 8 px grid filled with var(--accent) or var(--hot), and add class w-rise with style=\"--i:N\" (N a small number per column) for the same rise.",
	"The result tells you the visual's id, the height the page measured and any script errors. To fix a broken page, show the fixed one with replaces set to the broken visual's id: it takes the old one's place, so no dead frame stays in the reply.",
].join("\n\n");

export function showTool(deps: ShowDeps) {
	return defineTool({
		name: "show",
		label: "Show a visual",
		description: SHOW_INSTRUCTIONS,
		parameters: Type.Object({
			title: Type.String({ description: "A short title for the visual, e.g. \"Sales by month\"" }),
			html: Type.String({ description: "The whole page: HTML with its styles and scripts" }),
			replaces: Type.Optional(Type.String({ description: "The id of a visual this one fixes; it takes that visual's place" })),
		}),
		async execute(_id, params, signal) {
			const refusal = refusePage(params.html);
			if (refusal) throw new Error(refusal);
			const replaces = params.replaces?.trim() || undefined;
			if (replaces && (!/^[0-9a-f]{16}$/.test(replaces) || !existsSync(visualPath(deps.dataDir(), replaces))))
				throw new Error(`There is no visual "${replaces}" to replace. Use the id from the show result of the visual you're fixing.`);
			// Before anything is saved, so a refused image leaves no file behind.
			const html = inlineLocalImages(params.html);
			const ref: VisualRef = { id: randomBytes(8).toString("hex"), title: params.title.trim() || "Visual", ...(replaces ? { replaces } : {}) };
			const path = visualPath(deps.dataDir(), ref.id);
			mkdirSync(join(deps.dataDir(), "visuals"), { recursive: true });
			writeFileSync(path, html, "utf8");
			const replyId = deps.replyId();
			let text: string;
			try {
				const shown = (await deps.requests.request(
					"visual_show",
					{ ...(replyId ? { replyId } : {}), visualId: ref.id, title: ref.title, ...(replaces ? { replaces } : {}) },
					{ timeoutMs: SHOW_TIMEOUT_MS, signal },
				)) as VisualShown | undefined;
				text = describeShown(ref, { height: shown?.height ?? 0, errors: shown?.errors ?? [] });
			} catch (error) {
				if (!(error instanceof RequestTimeout)) throw error;
				text = `Saved "${ref.title}" (visual ${ref.id}), but its frame didn't report back in time, so its height and script errors are unknown.`;
			}
			// The broken page's file goes; its place in the reply and the thread is the new one's.
			if (replaces) rmSync(visualPath(deps.dataDir(), replaces), { force: true });
			return { content: [{ type: "text" as const, text }], details: { visual: ref } };
		},
	});
}
