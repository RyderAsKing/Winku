// look_at_screen: the shell captures the window the user was looking at.
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ScreenCapture } from "../protocol.ts";
import type { ShellRequests } from "../requests.ts";

export const SCREEN_TIMEOUT_MS = 10_000;

export function describeCapture(capture: ScreenCapture, imageIncluded: boolean): string {
	const lines = [
		capture.app ? `App: ${capture.app}` : "",
		capture.windowTitle ? `Window: ${capture.windowTitle}` : "",
	].filter(Boolean);
	const text = capture.text?.trim();
	lines.push("", text ? `Text in the window:\n${text}` : "No text could be read from the window.");
	if (!imageIncluded) lines.push("", "(No screenshot: the current model can't see images.)");
	return lines.join("\n").trim();
}

export function lookAtScreenTool(requests: ShellRequests, supportsImages: () => boolean) {
	return defineTool({
		name: "look_at_screen",
		label: "Look at the screen",
		description:
			"See the window the user is looking at: its app, title, the text in it and, when you can see images, a screenshot. " +
			"Use it when the user refers to something on their screen.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			const includeImage = supportsImages();
			const data = (await requests.request("screen_capture", { includeImage }, { timeoutMs: SCREEN_TIMEOUT_MS, signal })) as
				| ScreenCapture
				| undefined;
			const capture = data ?? {};
			const image = includeImage ? capture.image : undefined;
			const content: (TextContent | ImageContent)[] = [{ type: "text", text: describeCapture(capture, !!image) }];
			if (image) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
			return { content, details: undefined };
		},
	});
}
