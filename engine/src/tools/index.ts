// The assistant's tools for the main thread (and agent actions). See ARCHITECTURE.md "Agent tools".
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ScheduledRun } from "../protocol.ts";
import type { ShellRequests } from "../requests.ts";
import { clipboardTools } from "./clipboard.ts";
import type { DesktopRunner } from "./desktop/cli.ts";
import { desktopTools } from "./desktop/index.ts";
import { globFindOperations } from "./find.ts";
import { type Launcher, launchDetached, openTool } from "./open.ts";
import { gated, type PermissionPolicy } from "./permission.ts";
import { lookAtScreenTool } from "./screen.ts";
import type { ShellChoice } from "./shell.ts";
import { taskTools } from "./tasks.ts";
import { defaultWebDeps, type WebDeps, webFetchTool, webSearchTool } from "./web.ts";

// biome-ignore lint/suspicious/noExplicitAny: pi's tool definitions differ in params and details
export type AnyTool = ToolDefinition<any, any, any>;

export interface AgentToolDeps {
	/** The user's home folder: where the tools run. */
	home: string;
	shells: ShellChoice;
	/** ripgrep is on PATH: pi's grep needs it (the engine never downloads it). */
	ripgrep: boolean;
	policy: () => PermissionPolicy;
	requests: ShellRequests;
	/** The reply the tool call belongs to, for permission requests. */
	replyId: () => string | undefined;
	/** The active reply is a scheduled run (#43): its job. The task tools pass its id as `from`. */
	scheduledRun: () => ScheduledRun | undefined;
	/** The active reply's prompt was dictated. */
	spoken: () => boolean;
	supportsImages: () => boolean;
	searchKey: () => string | undefined;
	web?: WebDeps;
	launch?: Launcher;
	platform?: NodeJS.Platform;
	/** Computer use, when the agent-desktop CLI is bundled (cli.ts findAgentDesktop). */
	desktop?: { run: DesktopRunner; ownPids: number[] };
}

const PERMISSION_TIMEOUT_MS = 30 * 60_000;

/** Every agent tool; web_search is included but only active while a search key is set (activeToolNames). */
export function agentTools(deps: AgentToolDeps): AnyTool[] {
	const { home, shells } = deps;
	const shellOptions = { exposeSessionEnvironment: false };
	const tools: AnyTool[] = [
		createReadToolDefinition(home),
		createLsToolDefinition(home),
		createFindToolDefinition(home, { operations: globFindOperations }),
		...(deps.ripgrep ? [createGrepToolDefinition(home)] : []),
		createWriteToolDefinition(home),
		createEditToolDefinition(home),
	];
	if (shells.powershell) tools.push(createPowerShellToolDefinition(home, shellOptions));
	if (shells.bash)
		tools.push(
			createBashToolDefinition(home, {
				...shellOptions,
				...((deps.platform ?? process.platform) === "win32" ? { shellPath: shells.bash } : {}),
			}),
		);
	const desktop = deps.desktop ? desktopTools({ ...deps.desktop, requests: deps.requests }) : undefined;
	tools.push(
		openTool(home, deps.launch ?? launchDetached, deps.platform),
		webFetchTool(deps.web ?? defaultWebDeps),
		webSearchTool(deps.searchKey, deps.web ?? defaultWebDeps),
		lookAtScreenTool(deps.requests, deps.supportsImages, desktop?.glance),
		...(clipboardTools(deps.requests, deps.supportsImages) as AnyTool[]),
		...(taskTools({ requests: deps.requests, scheduledRun: deps.scheduledRun, spoken: deps.spoken, shells, ...(deps.platform ? { platform: deps.platform } : {}) }) as AnyTool[]),
		...((desktop?.tools ?? []) as AnyTool[]),
	);
	const gate = {
		policy: deps.policy,
		...(desktop ? { describe: desktop.describe } : {}),
		home,
		replyId: deps.replyId,
		scheduled: () => !!deps.scheduledRun(),
		ask: (params: Parameters<ShellRequests["request"]>[1], signal: AbortSignal | undefined) =>
			deps.requests.request("permission", params as never, { signal, timeoutMs: PERMISSION_TIMEOUT_MS }),
	};
	return tools.map((tool) => inHome(gated(tool, gate), home));
}

/**
 * pi's tools resolve paths against the session's cwd (ctx.cwd) before their own. The session
 * stays in the data folder (isolation), so each call sees the home folder as its cwd instead.
 */
function inHome(tool: AnyTool, home: string): AnyTool {
	return {
		...tool,
		execute: (toolCallId, params, signal, onUpdate, ctx) => {
			const homeCtx = ctx
				? new Proxy(ctx, { get: (target, key) => (key === "cwd" ? home : Reflect.get(target, key, target)) })
				: ctx;
			return tool.execute(toolCallId, params, signal, onUpdate, homeCtx);
		},
	};
}

/** Names to activate: all of them, minus web_search without a key. */
export function activeToolNames(tools: AnyTool[], hasSearchKey: boolean): string[] {
	return tools.map((t) => t.name).filter((name) => hasSearchKey || name !== "web_search");
}
