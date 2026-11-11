// look_at_screen: the shell captures the window the user was looking at.
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ScreenCapture } from "../protocol.ts";
import type { ShellRequests } from "../requests.ts";

export const SCREEN_TIMEOUT_MS = 10_000;

/** A compact outline of the window's controls (computer use), when it can be read cheaply. */
export type Glance = (window: { id: string; app?: string; title?: string }, signal: AbortSignal | undefined) => Promise<string | undefined>;

export function describeCapture(capture: ScreenCapture, imageIncluded: boolean, controls?: string): string {
	const lines = [
		capture.app ? `App: ${capture.app}` : "",
		capture.windowTitle ? `Window: ${capture.windowTitle}` : "",
		capture.windowId ? `Window id: ${capture.windowId}` : "",
	].filter(Boolean);
	const text = capture.text?.trim();
	if (text) lines.push("", `Text in the window:\n${text}`);
	else if (capture.chromium && imageIncluded)
		lines.push("", "(A Chromium-based app: its text wasn't read, because that slows it down. The screenshot shows it.)");
	else lines.push("", "No text could be read from the window.");
	if (controls) lines.push("", `Controls (refs for desktop_act):\n${controls}`);
	else if (capture.chromium && capture.windowId)
		lines.push("", "(Use desktop_observe if you need to operate this app; it is slower in Chromium-based apps.)");
	if (!imageIncluded) lines.push("", "(No screenshot: the current model can't see images.)");
	return lines.join("\n").trim();
}

export function lookAtScreenTool(requests: ShellRequests, supportsImages: () => boolean, glance?: Glance) {
	return defineTool({
		name: "look_at_screen",
		label: "Look at the screen",
		description:
			"See the window the user is looking at: its app, title, the text in it and, when you can see images, a screenshot. " +
			"Use it when the user refers to something on their screen." +
			(glance ? " Outside Chromium-based apps it also lists the window's controls with refs you can act on." : ""),
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			const includeImage = supportsImages();
			const data = (await requests.request("screen_capture", { includeImage }, { timeoutMs: SCREEN_TIMEOUT_MS, signal })) as
				| ScreenCapture
				| undefined;
			const capture = data ?? {};
			const image = includeImage ? capture.image : undefined;
			// Never for Chromium windows: only desktop_observe, when the user wants the app operated.
			const controls =
				glance && capture.windowId && !capture.chromium
					? await glance(
							{
								id: capture.windowId,
								...(capture.app ? { app: capture.app } : {}),
								...(capture.windowTitle ? { title: capture.windowTitle } : {}),
							},
							signal,
						)
					: undefined;
			const content: (TextContent | ImageContent)[] = [{ type: "text", text: describeCapture(capture, !!image, controls) }];
			if (image) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
			return { content, details: undefined };
		},
	});
}
