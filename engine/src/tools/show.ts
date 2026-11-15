// show: the assistant puts a visual (a small HTML page) into its reply (SPEC §3 Visuals, §7 Showing).
// The page is saved as visuals\<id>.html in the data folder; the main window shows it in a
// sandboxed frame served from the visual's own URL scheme and reports what the frame measured.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { VisualShown } from "../protocol.ts";
import { RequestTimeout, type ShellRequests } from "../requests.ts";

/** How long the frame has to load the page and report its height. */
export const SHOW_TIMEOUT_MS = 20_000;

/** What the thread keeps of a visual: the page itself lives in its file. */
export interface VisualRef {
	id: string;
	title: string;
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
export function describeShown(title: string, shown: VisualShown): string {
	const lines = [`Showed "${title}" in the reply. The frame measured ${Math.round(shown.height)} px tall.`];
	if (shown.errors.length) lines.push("Script errors:", ...shown.errors.map((e) => `- ${e}`));
	else lines.push("No script errors.");
	return lines.join("\n");
}

export const SHOW_INSTRUCTIONS = [
	"Draw a visual into your reply: a small HTML page, such as a chart, a table, a diagram or a small interactive widget, shown where you call this, between the text before and after it.",
	"When to draw: only when showing beats telling, such as numbers to compare, a shape to see or something to try. Most replies stay text; never draw for decoration or to restate what you said.",
	"Layout: write one complete page with its own <style> and <script>; it may load scripts and pictures from https URLs (no fetch or network calls from the page). It sits in a small translucent bubble, so keep it compact (about 560 px wide at most), with a short caption instead of a big heading, and let it grow to fit its content. Never size anything by the viewport: vh, dvh, svh and lvh units are refused. Pages over 512 KB are refused too.",
	"Look: every page already has Winku's palette as CSS variables (--text, --muted, --faint, --accent #5ef6f0, --hot #ffd56a, --error, --line, --panel, --font, --mono), no background (leave it that way; the bubble shows through), light text on dark, and a 4 px body margin. Use the variables instead of your own colours and fonts.",
	"House style: draw charts and diagrams as dot matrices, like Winku's own dot field, and not with smooth bars, lines or gradients. There are no faint unlit dots. A bar chart needs only HTML: <figure class=\"w-chart\"><figcaption>Build time by day</figcaption><div class=\"w-bars\"><div class=\"w-bar\" style=\"--rows:6\"><span class=\"w-value\">6s</span><i class=\"w-dots\"></i><span class=\"w-label\">Mon</span></div><div class=\"w-bar hot\" style=\"--rows:12\">...</div></div></figure>. --rows is a bar's height in dots (keep the tallest at about 14), --cols its width in dots (default 7), and class hot highlights the one bar that matters. The bars' dots rise once when the chart lands, then stay still. For other charts in SVG, draw circles r=2.3 on an 8 px grid filled with var(--accent) or var(--hot), and add class w-rise with style=\"--i:N\" (N a small number per column) for the same rise.",
	"The result tells you the height the page measured and any script errors, so you can fix a broken page.",
].join("\n\n");

export function showTool(deps: ShowDeps) {
	return defineTool({
		name: "show",
		label: "Show a visual",
		description: SHOW_INSTRUCTIONS,
		parameters: Type.Object({
			title: Type.String({ description: "A short title for the visual, e.g. \"Sales by month\"" }),
			html: Type.String({ description: "The whole page: HTML with its styles and scripts" }),
		}),
		async execute(_id, params, signal) {
			const refusal = refusePage(params.html);
			if (refusal) throw new Error(refusal);
			const ref: VisualRef = { id: randomBytes(8).toString("hex"), title: params.title.trim() || "Visual" };
			const path = visualPath(deps.dataDir(), ref.id);
			mkdirSync(join(deps.dataDir(), "visuals"), { recursive: true });
			writeFileSync(path, params.html, "utf8");
			const replyId = deps.replyId();
			let text: string;
			try {
				const shown = (await deps.requests.request(
					"visual_show",
					{ ...(replyId ? { replyId } : {}), visualId: ref.id, title: ref.title },
					{ timeoutMs: SHOW_TIMEOUT_MS, signal },
				)) as VisualShown | undefined;
				text = describeShown(ref.title, { height: shown?.height ?? 0, errors: shown?.errors ?? [] });
			} catch (error) {
				if (!(error instanceof RequestTimeout)) throw error;
				text = `Saved "${ref.title}", but its frame didn't report back in time, so its height and script errors are unknown.`;
			}
			return { content: [{ type: "text" as const, text }], details: { visual: ref } };
		},
	});
}
