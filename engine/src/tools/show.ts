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

export function showTool(deps: ShowDeps) {
	return defineTool({
		name: "show",
		label: "Show a visual",
		description:
			"Draw a visual into your reply: a small HTML page, such as a chart, a table, a diagram or a small interactive widget, " +
			"shown where you call this, between the text before and after it. Use it when showing beats telling; most replies stay text. " +
			"Write one complete page with its own <style> and <script>; it may load scripts and pictures from https URLs. " +
			"To show a local picture, give its absolute path as an <img> src; it is written into the page, and must be a real image under 2 MB. " +
			"Give it no background of its own and let it grow to fit its content; don't size anything by the viewport. " +
			"The result tells you the visual's id, the height the page measured and any script errors. " +
			"To fix a broken page, show the fixed one with `replaces` set to the broken visual's id: it takes the old one's place.",
		parameters: Type.Object({
			title: Type.String({ description: "A short title for the visual, e.g. \"Sales by month\"" }),
			html: Type.String({ description: "The whole page: HTML with its styles and scripts" }),
			replaces: Type.Optional(Type.String({ description: "The id of a visual this one fixes; it takes that visual's place" })),
		}),
		async execute(_id, params, signal) {
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
