// `open`: an http(s) URL, an existing file or folder, or an app by name, the way Explorer would.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveFromHome } from "./paths.ts";

export type OpenTarget =
	| { kind: "url"; target: string }
	| { kind: "path"; target: string }
	| { kind: "app"; target: string };

export interface LaunchCommand {
	command: string;
	args: string[];
	/** Windows: pass args as written (already quoted), for cmd.exe's own parser. */
	verbatim?: boolean;
}

/** Runs a program detached, without a shell. Resolves once it has started. */
export type Launcher = (launch: LaunchCommand) => Promise<void>;

/** Letters, digits, spaces and . _ - ( ) + only: nothing cmd.exe or a shell would interpret. */
const APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._()+-]*$/u;
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Decide what a target is, or throw why it can't be opened. Only http(s) URLs are opened; every
 * other scheme (file:, javascript:, ms-settings:, …) is refused. Paths must exist. UNC and device
 * paths are refused. Anything else must be a plain app name.
 */
export function classifyOpenTarget(raw: string, home: string, platform: NodeJS.Platform = process.platform): OpenTarget {
	const value = raw.trim();
	if (!value) throw new Error("Nothing to open");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
	if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("The target contains control characters");
	const scheme = SCHEME.exec(value)?.[1]?.toLowerCase();
	// "C:\…" is a drive letter, not a scheme.
	const driveLetter = scheme?.length === 1 && /^[a-z]:[\\/]/i.test(value);
	if (scheme && !driveLetter) {
		if (scheme !== "http" && scheme !== "https") throw new Error(`Only http and https links can be opened, not ${scheme}:`);
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw new Error("That is not a valid URL");
		}
		if (!url.hostname) throw new Error("That URL has no host");
		return { kind: "url", target: url.href };
	}
	if (/^[\\/]{2}/.test(value)) throw new Error("Network (UNC) and device paths can't be opened");
	const looksLikePath =
		driveLetter || value.startsWith("~") || value.startsWith(".") || value.includes("/") || value.includes("\\");
	const path = resolveFromHome(value, home);
	if (existsSync(path)) return { kind: "path", target: path };
	if (looksLikePath) throw new Error(`No such file or folder: ${path}`);
	if (!APP_NAME.test(value) || value.length > 100)
		throw new Error("App names may only contain letters, digits, spaces and . _ - ( ) +");
	if (platform === "win32" && /%/.test(value)) throw new Error("App names can't contain %");
	return { kind: "app", target: value };
}

/** The program and argv that open a target on each platform. No shell parses these. */
export function openCommand(target: OpenTarget, platform: NodeJS.Platform = process.platform): LaunchCommand {
	if (platform === "win32") {
		// URLs and paths go through the file association, never through cmd.exe.
		if (target.kind === "url") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", target.target] };
		if (target.kind === "path") return { command: "explorer.exe", args: [target.target] };
		// App names are limited to characters cmd.exe doesn't interpret (classifyOpenTarget), so quoting is enough.
		return { command: "cmd.exe", args: ["/d", "/c", "start", '""', `"${target.target}"`], verbatim: true };
	}
	if (platform === "darwin")
		return target.kind === "app" ? { command: "open", args: ["-a", target.target] } : { command: "open", args: [target.target] };
	return target.kind === "app" ? { command: target.target, args: [] } : { command: "xdg-open", args: [target.target] };
}

export const launchDetached: Launcher = ({ command, args, verbatim }) =>
	new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore",
			shell: false,
			windowsVerbatimArguments: !!verbatim,
		});
		child.once("error", (error) => reject(error));
		child.once("spawn", () => {
			child.unref();
			resolvePromise();
		});
	});

export function openTool(home: string, launch: Launcher = launchDetached, platform: NodeJS.Platform = process.platform) {
	return defineTool({
		name: "open",
		label: "Open",
		description:
			"Open something for the user the way double-clicking would: an http(s) link in their browser, a file in its default app, " +
			'a folder in the file manager, or an app by name (e.g. "notepad", "calc"). Relative paths start in the home folder.',
		parameters: Type.Object({
			target: Type.String({ description: "An http(s) URL, a file or folder path, or an app name" }),
		}),
		async execute(_id, params) {
			const target = classifyOpenTarget(params.target, home, platform);
			await launch(openCommand(target, platform));
			return { content: [{ type: "text", text: `Opened ${target.target}` }], details: undefined };
		},
	});
}
