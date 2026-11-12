// "Ask before running": a check in front of tools that write, run or open things.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolPermissionRequest } from "../protocol.ts";
import { RequestAborted } from "../requests.ts";
import { resolveFromHome } from "./paths.ts";

export const DECLINED = "The user declined to run this.";
export const GATED_TOOLS = new Set(["write", "edit", "powershell", "bash", "open", "watch", "desktop_act", "desktop_press", "desktop_window", "clipboard_write", "clipboard_edit"]);

/** In a scheduled run nobody is at the keyboard: these ask even when "Ask before running" is off. */
export const ASK_IN_SCHEDULED_RUN = new Set(["desktop_act", "desktop_press", "desktop_window"]);

export type Decision = "allow_once" | "always" | "deny";

/** The live settings the gate reads on every call; configure updates them in place. */
export interface PermissionPolicy {
	askBeforeRunning: boolean;
	/** Lower-cased allowKeys. */
	alwaysAllow: Set<string>;
}

export function policyFrom(askBeforeRunning: boolean, alwaysAllow: readonly string[]): PermissionPolicy {
	return { askBeforeRunning, alwaysAllow: new Set(alwaysAllow.map((k) => k.toLowerCase())) };
}

/** First word of a command line, without quotes or a leading call operator: "Remove-Item", "git". */
export function firstCommandWord(command: string): string {
	let rest = command.trim();
	// PowerShell's call operator (& "C:\x.exe") and bash env assignments (FOO=1 cmd).
	rest = rest.replace(/^&\s*/, "");
	while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(rest)) rest = rest.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
	const quoted = /^(["'])(.*?)\1/.exec(rest);
	if (quoted) return quoted[2] ?? "";
	return rest.split(/[\s;|&()<>]/)[0] ?? "";
}

/**
 * A command that does more than run its first word: chained (; && ||), piped, redirected, a
 * subshell or substitution, or several lines. "Always allow" a first word never covers these.
 */
export function isCompoundCommand(command: string): boolean {
	return /[;&|<>`\n\r]|\$\(/.test(command.trim());
}

function oneLine(text: string, max = 160): string {
	const line = text.replace(/\s*\r?\n\s*/g, " ⏎ ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface GateCheck {
	summary: string;
	allowKey: string;
	/** Whether alwaysAllow may skip asking. */
	coverable: boolean;
}

/** What to show the user and the key for "Always allow", for a gated tool call. */
export function describeCall(tool: string, args: Record<string, unknown>, home: string): GateCheck {
	const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
	switch (tool) {
		case "write":
		case "edit": {
			const path = resolveFromHome(str("path"), home);
			return { summary: `${tool === "write" ? "Write" : "Edit"} ${path}`, allowKey: `${tool}:${path}`, coverable: true };
		}
		case "powershell":
		case "bash": {
			const command = str("command");
			return {
				summary: `Run: ${oneLine(command)}`,
				allowKey: `${tool}:${firstCommandWord(command)}`,
				coverable: !isCompoundCommand(command),
			};
		}
		case "watch": {
			const command = str("command");
			return {
				summary: `Watch, running in the background: ${oneLine(command)}`,
				allowKey: `powershell:${firstCommandWord(command)}`,
				coverable: !isCompoundCommand(command),
			};
		}
		case "open": {
			const target = str("target").trim();
			return { summary: `Open ${oneLine(target)}`, allowKey: `open:${target}`, coverable: true };
		}
		case "clipboard_write":
			return { summary: `Put on the clipboard: ${oneLine(str("text"))}`, allowKey: tool, coverable: true };
		case "clipboard_edit":
			return { summary: `Edit the clipboard: ${oneLine(str("oldText"), 70)} → ${oneLine(str("newText"), 70)}`, allowKey: tool, coverable: true };
		default:
			return { summary: tool, allowKey: tool, coverable: true };
	}
}

export interface GateDeps {
	policy: () => PermissionPolicy;
	home: string;
	replyId: () => string | undefined;
	ask: (request: ToolPermissionRequest, signal: AbortSignal | undefined) => Promise<unknown>;
	/** Summaries for tools whose description needs live state (the desktop_* tools); undefined falls back to describeCall. */
	describe?: (tool: string, args: Record<string, unknown>) => GateCheck | undefined;
	/** The current reply is a scheduled run. */
	scheduled?: () => boolean;
}

/** Ask the user if needed. Resolves when the call may run; throws DECLINED otherwise. */
export async function checkPermission(tool: string, args: Record<string, unknown>, deps: GateDeps, signal?: AbortSignal): Promise<void> {
	const policy = deps.policy();
	if (!GATED_TOOLS.has(tool)) return;
	if (!policy.askBeforeRunning && !(ASK_IN_SCHEDULED_RUN.has(tool) && deps.scheduled?.())) return;
	const call = deps.describe?.(tool, args) ?? describeCall(tool, args, deps.home);
	const key = call.allowKey.toLowerCase();
	if (call.coverable && policy.alwaysAllow.has(key)) return;
	const replyId = deps.replyId();
	let decision: unknown;
	try {
		const data = (await deps.ask(
			{ ...(replyId ? { replyId } : {}), tool, summary: call.summary, allowKey: call.allowKey },
			signal,
		)) as { decision?: unknown } | undefined;
		decision = data?.decision;
	} catch (error) {
		if (error instanceof RequestAborted) throw new Error(DECLINED);
		throw new Error(`${DECLINED} (Couldn't ask: ${(error as Error).message})`);
	}
	if (decision === "always") {
		policy.alwaysAllow.add(key);
		return;
	}
	if (decision === "allow_once") return;
	throw new Error(DECLINED);
}

/** Wrap a tool so each call passes the gate first. */
// biome-ignore lint/suspicious/noExplicitAny: wraps any tool definition
export function gated<T extends ToolDefinition<any, any, any>>(tool: T, deps: GateDeps): T {
	if (!GATED_TOOLS.has(tool.name)) return tool;
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			await checkPermission(tool.name, (params ?? {}) as Record<string, unknown>, deps, signal);
			if (signal?.aborted) throw new Error(DECLINED);
			return tool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}
