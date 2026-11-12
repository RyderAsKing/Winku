// clipboard_read, clipboard_write, clipboard_edit: served by the shell's clipboard_* requests.
// The edit's replacement logic lives here, on top of read and write.
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ClipboardContent } from "../protocol.ts";
import type { ShellRequests } from "../requests.ts";

export const CLIPBOARD_TIMEOUT_MS = 10_000;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

async function readClipboard(requests: ShellRequests, includeImage: boolean, signal: AbortSignal | undefined): Promise<ClipboardContent> {
	const data = (await requests.request("clipboard_read", { includeImage }, { timeoutMs: CLIPBOARD_TIMEOUT_MS, signal })) as
		| ClipboardContent
		| undefined;
	return data ?? { kind: "empty" };
}

export function describeClipboard(clip: ClipboardContent, imageIncluded: boolean): string {
	switch (clip.kind) {
		case "empty":
			return "The clipboard is empty.";
		case "private":
			return "The clipboard holds content marked private (by a password manager), so it can't be read.";
		case "text":
			return `Text on the clipboard:\n${clip.text}`;
		case "files":
			return `Files on the clipboard:\n${clip.paths.join("\n")}`;
		case "image": {
			const size = clip.width && clip.height ? ` (${clip.width}×${clip.height})` : "";
			return imageIncluded ? `An image on the clipboard${size}.` : `An image on the clipboard${size}. (No image: the current model can't see images.)`;
		}
	}
}

export function clipboardTools(requests: ShellRequests, supportsImages: () => boolean) {
	const read = defineTool({
		name: "clipboard_read",
		label: "Read the clipboard",
		description:
			"Read what is on the user's clipboard now: text, an image (when you can see images) or file paths. " +
			'Use it when the user refers to something they copied ("this", "what I copied").',
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			const includeImage = supportsImages();
			const clip = await readClipboard(requests, includeImage, signal);
			const image = includeImage && clip.kind === "image" ? clip.image : undefined;
			const content: (TextContent | ImageContent)[] = [{ type: "text", text: describeClipboard(clip, !!image) }];
			if (image) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
			return { content, details: undefined };
		},
	});
	const write = defineTool({
		name: "clipboard_write",
		label: "Write the clipboard",
		description: "Replace the user's clipboard with text, so they can paste it anywhere.",
		parameters: Type.Object({ text: Type.String({ description: "The text to put on the clipboard" }) }),
		async execute(_id, params, signal) {
			await requests.request("clipboard_write", { text: params.text }, { timeoutMs: CLIPBOARD_TIMEOUT_MS, signal });
			return text("The text is on the clipboard.");
		},
	});
	const edit = defineTool({
		name: "clipboard_edit",
		label: "Edit the clipboard",
		description:
			"Replace one part of the text on the clipboard and leave the rest as it is. oldText must occur exactly once; " +
			"otherwise nothing changes and the call fails.",
		parameters: Type.Object({
			oldText: Type.String({ description: "The exact text to replace; must occur once" }),
			newText: Type.String({ description: "The replacement" }),
		}),
		async execute(_id, params, signal) {
			const clip = await readClipboard(requests, false, signal);
			if (clip.kind !== "text") throw new Error(`The clipboard holds no text to edit. ${describeClipboard(clip, false)}`);
			if (!params.oldText) throw new Error("oldText is empty. The clipboard was not changed.");
			const at = clip.text.indexOf(params.oldText);
			if (at < 0) throw new Error("oldText was not found on the clipboard. The clipboard was not changed.");
			if (clip.text.indexOf(params.oldText, at + 1) >= 0)
				throw new Error("oldText occurs more than once on the clipboard; include more of the text around it. The clipboard was not changed.");
			const next = clip.text.slice(0, at) + params.newText + clip.text.slice(at + params.oldText.length);
			await requests.request("clipboard_write", { text: next }, { timeoutMs: CLIPBOARD_TIMEOUT_MS, signal });
			return text("The clipboard was edited.");
		},
	});
	return [read, write, edit];
}
