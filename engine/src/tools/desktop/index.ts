// Computer use: the desktop_* tools on top of the bundled agent-desktop CLI. See ARCHITECTURE.md
// "Computer use". The target is the window the user was in before the bar (the shell's
// `screen_target`); Winku's own windows are never observed or acted on.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ScreenTarget } from "../../protocol.ts";
import type { ShellRequests } from "../../requests.ts";
import type { GateCheck } from "../permission.ts";
import { DesktopAborted, type DesktopRunner, type Envelope } from "./cli.ts";
import { clip, renderAction, renderError, renderSnapshot, renderWindows, type SnapshotData, type WindowRow } from "./render.ts";

/** Characters of tree per result. A full observe gets more than the look after an action. */
export const OBSERVE_CAP = 6000;
export const AFTER_ACTION_CAP = 2500;
export const GLANCE_CAP = 2500;
const TARGET_TIMEOUT_MS = 5_000;
const WAIT_MAX_MS = 30_000;
/** Snapshot budget (agent-desktop's own default is 3000); Chromium needs longer on first contact. */
const SNAPSHOT_MS = 4_000;
const CHROMIUM_SNAPSHOT_MS = 15_000;
/** Kill a call that runs this much past its own budget. */
const PROCESS_MARGIN_MS = 10_000;

const REF = /^@([A-Za-z0-9]+):e\d+$/;
const WINDOW_ID = /^w-\d+$/;

export const DESKTOP_GATED = new Set(["desktop_act", "desktop_press", "desktop_window"]);

export interface DesktopDeps {
	run: DesktopRunner;
	requests: ShellRequests;
	/** Process ids whose windows are Winku's own (the shell). */
	ownPids: number[];
}

interface KnownWindow {
	id: string;
	app?: string;
	title?: string;
	chromium?: boolean;
}

interface SnapshotEntry {
	window: KnownWindow;
	labels: Map<string, string>;
}

const OWN_APP = /^winku(-engine)?(\.exe)?$/i;

const ACTIONS = [
	"click",
	"double_click",
	"right_click",
	"type",
	"set_value",
	"clear",
	"select",
	"check",
	"uncheck",
	"toggle",
	"expand",
	"collapse",
	"scroll",
	"scroll_to",
	"focus",
] as const;
type Action = (typeof ACTIONS)[number];

const ACTION_VERB: Record<Action, string> = {
	click: "Click",
	double_click: "Double-click",
	right_click: "Right-click",
	type: "Type into",
	set_value: "Set",
	clear: "Clear",
	select: "Select in",
	check: "Check",
	uncheck: "Uncheck",
	toggle: "Toggle",
	expand: "Expand",
	collapse: "Collapse",
	scroll: "Scroll",
	scroll_to: "Scroll to",
	focus: "Focus",
};

/**
 * On Windows these have no semantic (accessibility-only) path in agent-desktop: they use real
 * input and may bring the window to the front. Everything else stays headless: no pointer
 * movement, no focus change.
 */
const PHYSICAL = new Set<Action>(["double_click", "right_click", "type", "focus"]);

const WINDOW_ACTIONS = ["focus", "launch", "minimize", "maximize", "restore"] as const;
type WindowAction = (typeof WINDOW_ACTIONS)[number];

class DesktopState {
	readonly windows = new Map<string, KnownWindow>();
	readonly snapshots = new Map<string, SnapshotEntry>();

	constructor(private readonly deps: DesktopDeps) {}

	isOwn(row: { pid?: number; app_name?: string }): boolean {
		return (row.pid !== undefined && this.deps.ownPids.includes(row.pid)) || OWN_APP.test(row.app_name ?? "");
	}

	/** The window the user was in before the bar, from the shell. */
	async target(signal: AbortSignal | undefined): Promise<KnownWindow> {
		let data: ScreenTarget | undefined;
		try {
			data = (await this.deps.requests.request("screen_target", {}, { timeoutMs: TARGET_TIMEOUT_MS, signal })) as ScreenTarget;
		} catch (error) {
			if (signal?.aborted) throw new DesktopAborted();
			throw new Error(`Couldn't tell which window the user is in: ${(error as Error).message}`);
		}
		if (!data?.windowId || !WINDOW_ID.test(data.windowId)) throw new Error("There is no window to work with.");
		const known: KnownWindow = {
			id: data.windowId,
			...(data.app ? { app: data.app } : {}),
			...(data.windowTitle ? { title: data.windowTitle } : {}),
			chromium: !!data.chromium,
		};
		this.windows.set(known.id, known);
		return known;
	}

	async listWindows(signal: AbortSignal | undefined): Promise<WindowRow[]> {
		const { envelope } = await this.deps.run(["list-windows"], { signal, timeoutMs: 5_000 + PROCESS_MARGIN_MS });
		if (!envelope.ok) throw new Error(renderError("Listing windows", envelope));
		const rows = (Array.isArray(envelope.data) ? envelope.data : []) as WindowRow[];
		const mine = rows.filter((row) => row && typeof row.id === "string" && !this.isOwn(row));
		for (const row of mine) {
			const prev = this.windows.get(row.id);
			this.windows.set(row.id, { ...prev, id: row.id, app: row.app_name, title: row.title });
		}
		return mine;
	}

	/** A window the model named, or the target. Winku's own windows are refused. */
	async window(id: string | undefined, signal: AbortSignal | undefined): Promise<KnownWindow> {
		if (!id) return this.target(signal);
		const wanted = id.trim();
		if (!WINDOW_ID.test(wanted)) throw new Error(`"${id}" isn't a window id. Window ids look like w-12345 (from desktop_windows).`);
		const known = this.windows.get(wanted);
		if (known) return known;
		await this.listWindows(signal);
		const fresh = this.windows.get(wanted);
		if (!fresh) throw new Error(`There is no window ${wanted} that Winku may use. List windows again.`);
		return fresh;
	}

	/** The snapshot a ref belongs to; refs are only accepted from snapshots taken here. */
	entryFor(ref: string): SnapshotEntry {
		const match = REF.exec(ref.trim());
		if (!match) throw new Error(`"${ref}" isn't a ref. Refs look like @s8f3k2p9:e5 and come from desktop_observe.`);
		const entry = this.snapshots.get(match[1] as string);
		if (!entry) throw new Error(`${ref} isn't from a snapshot taken in this conversation. Observe the window again and use a new ref.`);
		return entry;
	}

	record(data: SnapshotData, window: KnownWindow, labels: Map<string, string>): void {
		const id = data.snapshot_id;
		if (!id) return;
		const entry = this.snapshots.get(id);
		if (entry) for (const [ref, label] of labels) entry.labels.set(ref, label);
		else this.snapshots.set(id, { window, labels: new Map(labels) });
		// Keep the most recent few hundred: older refs would be stale anyway.
		if (this.snapshots.size > 200) this.snapshots.delete(this.snapshots.keys().next().value as string);
	}

	/** Observe a window (or drill into a ref). Returns the text for the model. */
	async observe(
		options: { window: KnownWindow; root?: string; surface?: string; cap: number; waitFor?: { selector: string; gone: boolean; timeoutMs: number } },
		signal: AbortSignal | undefined,
	): Promise<{ ok: boolean; text: string }> {
		const { window, root, surface, cap, waitFor } = options;
		const budget = window.chromium ? CHROMIUM_SNAPSHOT_MS : SNAPSHOT_MS;
		const base = ["snapshot", "-i", "--compact", "--timeout-ms", String(budget)];
		const scope = root ? ["--root", root] : ["--window-id", window.id, ...(surface ? ["--surface", surface] : [])];
		const wait = waitFor
			? [waitFor.gone ? "--wait-for-gone" : "--wait-for", waitFor.selector, "--wait-timeout", String(waitFor.timeoutMs)]
			: [];
		const timeoutMs = budget + (waitFor?.timeoutMs ?? 0) + PROCESS_MARGIN_MS;
		const { envelope } = await this.deps.run([...base, ...scope, ...wait], { signal, timeoutMs });
		if (!envelope.ok) return { ok: false, text: renderError(root ? `Drilling into ${root}` : "Observing the window", envelope) };
		let data = snapshotData(envelope);
		let shown = renderSnapshot(data, cap, !!root);
		// Too big for one look: a shallow map with drill targets instead (skeleton refs are just as valid).
		if (shown.cut && !root && !waitFor) {
			const skeleton = await this.deps.run([...base, "--skeleton", ...scope], { signal, timeoutMs });
			if (skeleton.envelope.ok) {
				this.record(data, window, shown.labels);
				data = snapshotData(skeleton.envelope);
				shown = renderSnapshot(data, cap);
				shown.text = `${shown.text}\nThis window is big, so this is a shallow map: drill into a container with root=<its ref> to see inside.`;
			}
		}
		this.record(data, window, shown.labels);
		return { ok: true, text: shown.text };
	}
}

function snapshotData(envelope: Envelope): SnapshotData {
	const data = (envelope.data ?? {}) as SnapshotData & { snapshot?: SnapshotData };
	// --wait-for returns the snapshot under `snapshot` on some versions.
	return data.tree ? data : (data.snapshot ?? data);
}

function windowName(window: KnownWindow): string {
	return window.app ? `${window.app}${window.title ? ` "${clip(window.title, 60)}"` : ""}` : window.id;
}

/** The CLI arguments for one ref action. Positionals go after `--`, so text starting with "-" stays text. */
export function actionArgs(action: Action, ref: string, params: { text?: string; direction?: string; amount?: number }): { args: string[]; stdin?: string } {
	const headed = PHYSICAL.has(action) ? ["--headed"] : [];
	const command = action.replace(/_/g, "-");
	switch (action) {
		case "type":
		case "set_value":
			return { args: [command, ...headed, "--stdin", "--", ref], stdin: params.text ?? "" };
		case "select":
			return { args: [command, ...headed, "--", ref, params.text ?? ""] };
		case "scroll":
			return {
				args: [
					command,
					"--direction",
					params.direction ?? "down",
					"--amount",
					String(Math.max(1, Math.min(50, Math.round(params.amount ?? 3)))),
					"--",
					ref,
				],
			};
		default:
			return { args: [command, ...headed, "--", ref] };
	}
}

function throwIfAborted(error: unknown): never {
	if (error instanceof DesktopAborted) throw new Error("Stopped.");
	throw error;
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

/** Fail the tool call (pi marks it as an error) with advice for the model. */
function failed(message: string): never {
	throw new Error(message);
}

export interface DesktopTools {
	tools: ReturnType<typeof defineTool>[];
	/** Permission summaries and allow keys for the gated desktop tools. */
	describe: (tool: string, args: Record<string, unknown>) => GateCheck | undefined;
	/** A compact snapshot of a (non-Chromium) window for look_at_screen; undefined on failure. */
	glance: (window: { id: string; app?: string; title?: string }, signal: AbortSignal | undefined) => Promise<string | undefined>;
}

export function desktopTools(deps: DesktopDeps): DesktopTools {
	const state = new DesktopState(deps);

	const observe = defineTool({
		name: "desktop_observe",
		label: "Observe a window",
		description:
			"Read a window's controls as an outline, each actionable one with a ref like @s8f3k2p9:e5. With no window it reads the window the user was in. " +
			"Use it before acting, and again after acting to check the result. A ref belongs to the snapshot that printed it; observe again after the UI changes. " +
			"For a big window you get a shallow map: pass root=<container ref> to see inside it. Pass surface=menu or sheet when a menu or dialog is open. " +
			"Only observe an app you're operating or the user asked about: in Chromium-based apps (Chrome, Edge, VS Code, Slack, Teams, other Electron apps) " +
			"it switches on the app's accessibility tree, which slows that app until it restarts.",
		parameters: Type.Object({
			window: Type.Optional(Type.String({ description: "A window id (w-…) from desktop_windows; default: the window the user was in" })),
			root: Type.Optional(Type.String({ description: "A ref to read just that part of the window, deeper" })),
			surface: Type.Optional(
				Type.Union([Type.Literal("menu"), Type.Literal("sheet"), Type.Literal("focused")], {
					description: "Read an open menu, a dialog sheet, or the focused area instead of the whole window",
				}),
			),
		}),
		async execute(_id, params, signal) {
			try {
				const window = params.root ? state.entryFor(params.root).window : await state.window(params.window, signal);
				const result = await state.observe(
					{
						window,
						...(params.root ? { root: params.root.trim() } : {}),
						...(params.surface && !params.root ? { surface: params.surface } : {}),
						cap: OBSERVE_CAP,
					},
					signal,
				);
				if (!result.ok) failed(result.text);
				return text(result.text);
			} catch (error) {
				throwIfAborted(error);
			}
		},
	});

	const act = defineTool({
		name: "desktop_act",
		label: "Act on a control",
		description:
			"Act on a control by its ref from desktop_observe, then look again: the result includes a fresh outline of the window. " +
			"Prefer set_value to fill a text field (no keystrokes, the window stays where it is); type sends real keystrokes at the caret and brings the window to the front. " +
			"double_click, right_click and focus also use real input. select picks an option by its text; check/uncheck are safer than toggle. " +
			"On STALE_REF or SNAPSHOT_NOT_FOUND, observe again and use the new ref. Retry a failed action only when the result says nothing was sent; " +
			"otherwise check the window first, because a repeat can click or type twice.",
		parameters: Type.Object({
			ref: Type.String({ description: "The control's ref, e.g. @s8f3k2p9:e5" }),
			action: Type.Union(
				ACTIONS.map((a) => Type.Literal(a)),
				{ description: "What to do" },
			),
			text: Type.Optional(Type.String({ description: "type / set_value: the text; select: the option's text" })),
			direction: Type.Optional(
				Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")], {
					description: "scroll: direction (default down)",
				}),
			),
			amount: Type.Optional(Type.Number({ description: "scroll: how far, in scroll units (default 3)" })),
			observe: Type.Optional(Type.Boolean({ description: "Include a fresh outline after acting (default true)" })),
		}),
		async execute(_id, params, signal) {
			try {
				const action = params.action as Action;
				if ((action === "type" || action === "set_value" || action === "select") && params.text === undefined)
					failed(`${action} needs text.`);
				const ref = params.ref.trim();
				const entry = state.entryFor(ref);
				const { args, stdin } = actionArgs(action, ref, params);
				const chars = params.text?.length ?? 0;
				const timeoutMs = 5_000 + (action === "type" ? 30 * chars : 0) + PROCESS_MARGIN_MS;
				const { envelope } = await deps.run(args, { signal, timeoutMs, ...(stdin !== undefined ? { stdin } : {}) });
				const label = `${ACTION_VERB[action]} ${entry.labels.get(ref) ?? ref}`;
				if (!envelope.ok) failed(renderError(label, envelope));
				let out = renderAction(label, envelope);
				if (params.observe !== false) {
					const after = await state.observe({ window: entry.window, cap: AFTER_ACTION_CAP }, signal);
					out += `\n\nNow:\n${after.text}`;
				}
				return text(out);
			} catch (error) {
				throwIfAborted(error);
			}
		},
	});

	const press = defineTool({
		name: "desktop_press",
		label: "Press keys",
		description:
			'Press a key or shortcut in a window, e.g. "return", "escape", "tab", "ctrl+s", "ctrl+shift+t", "alt+f". ' +
			"It brings the window to the front first and sends real keystrokes. Default window: the one the user was in. " +
			"Some shortcuts (alt+f4, win+r, …) are refused. Observe afterwards to see what it did.",
		parameters: Type.Object({
			keys: Type.String({ description: "Key or combo joined with +: ctrl, alt, shift, return, escape, tab, f1…f12, up, …" }),
			window: Type.Optional(Type.String({ description: "A window id (w-…); default: the window the user was in" })),
		}),
		async execute(_id, params, signal) {
			try {
				const window = await state.window(params.window, signal);
				const keys = params.keys.trim().toLowerCase();
				if (!keys) failed("Which keys?");
				const { envelope } = await deps.run(["press", "--headed", "--window-id", window.id, "--", keys], {
					signal,
					timeoutMs: 5_000 + PROCESS_MARGIN_MS,
				});
				const label = `Press ${keys} in ${windowName(window)}`;
				if (!envelope.ok) failed(renderError(label, envelope));
				return text(renderAction(label, envelope));
			} catch (error) {
				throwIfAborted(error);
			}
		},
	});

	const windows = defineTool({
		name: "desktop_windows",
		label: "List windows",
		description:
			"List the open windows (id, app, title). The window the user was in is marked. Use an id with the other desktop_ tools to work in another window.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			try {
				const rows = await state.listWindows(signal);
				let target: string | undefined;
				try {
					target = (await state.target(signal)).id;
				} catch (error) {
					if (error instanceof DesktopAborted) throw error;
				}
				const list = renderWindows(rows);
				const marked = target ? list.replace(new RegExp(`^${target} (.*)$`, "m"), `${target} $1 [the user was here]`) : list;
				return text(marked);
			} catch (error) {
				throwIfAborted(error);
			}
		},
	});

	const windowTool = defineTool({
		name: "desktop_window",
		label: "Manage a window",
		description:
			"focus, minimize, maximize or restore a window (a minimized window must be restored before you can act in it), " +
			'or launch an app and get its window: app is "notepad", "mspaint", "charmap" or a full path to an .exe. ' +
			"For other apps use open, then desktop_windows to find the new window.",
		parameters: Type.Object({
			action: Type.Union(
				WINDOW_ACTIONS.map((a) => Type.Literal(a)),
				{ description: "What to do" },
			),
			window: Type.Optional(Type.String({ description: "A window id (w-…); default: the window the user was in" })),
			app: Type.Optional(Type.String({ description: "launch: the app" })),
		}),
		async execute(_id, params, signal) {
			try {
				const action = params.action as WindowAction;
				if (action === "launch") {
					const app = params.app?.trim();
					if (!app) failed("launch needs app.");
					if (OWN_APP.test(app)) failed("That's Winku itself.");
					const { envelope } = await deps.run(["launch", "--activate", "--timeout", "15000", "--", app], {
						signal,
						timeoutMs: 15_000 + PROCESS_MARGIN_MS,
					});
					if (!envelope.ok) failed(renderError(`Launch ${app}`, envelope));
					const data = (envelope.data ?? {}) as { app?: string; window?: { id?: string; title?: string } };
					const window = data.window;
					if (window?.id && WINDOW_ID.test(window.id)) {
						state.windows.set(window.id, { id: window.id, app: data.app ?? app, ...(window.title ? { title: window.title } : {}) });
						return text(`Launched ${data.app ?? app}: window ${window.id} ${JSON.stringify(clip(window.title ?? "", 100))}.`);
					}
					return text(`Launched ${data.app ?? app}, but it shows no window yet. Wait, then list windows.`);
				}
				const window = await state.window(params.window, signal);
				const command = action === "focus" ? "focus-window" : action;
				const { envelope } = await deps.run([command, "--headed", "--window-id", window.id], {
					signal,
					timeoutMs: 5_000 + PROCESS_MARGIN_MS,
				});
				const label = `${action[0]?.toUpperCase()}${action.slice(1)} ${windowName(window)}`;
				if (!envelope.ok) failed(renderError(label, envelope));
				return text(renderAction(label, envelope));
			} catch (error) {
				throwIfAborted(error);
			}
		},
	});

	const wait = defineTool({
		name: "desktop_wait",
		label: "Wait",
		description:
			"Wait for something in a window instead of guessing with a pause: give text (and/or role) to wait until a matching control appears, " +
			"or gone=true until it disappears; you get the window's fresh outline. With only ms, it pauses (at most 30 s).",
		parameters: Type.Object({
			text: Type.Optional(Type.String({ description: "Text to wait for (in a name, value or description)" })),
			role: Type.Optional(Type.String({ description: 'A role to wait for, e.g. "button", "dialog"' })),
			gone: Type.Optional(Type.Boolean({ description: "Wait until it's gone instead" })),
			window: Type.Optional(Type.String({ description: "A window id (w-…); default: the window the user was in" })),
			ms: Type.Optional(Type.Number({ description: "Without text/role: how long to pause. With them: how long to wait at most (default 10000)" })),
		}),
		async execute(_id, params, signal) {
			try {
				const limit = Math.max(0, Math.min(WAIT_MAX_MS, Math.round(params.ms ?? 10_000)));
				if (!params.text && !params.role) {
					await sleep(Math.min(limit, WAIT_MAX_MS), signal);
					return text(`Waited ${limit} ms.`);
				}
				const window = await state.window(params.window, signal);
				const selector = `${params.role ?? ""}:${params.text ?? ""}`;
				const result = await state.observe(
					{ window, cap: AFTER_ACTION_CAP, waitFor: { selector, gone: !!params.gone, timeoutMs: limit } },
					signal,
				);
				if (!result.ok) failed(result.text);
				return text(result.text);
			} catch (error) {
				throwIfAborted(error);
			}
		},
	});

	const describe = (tool: string, args: Record<string, unknown>): GateCheck | undefined => {
		const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string).trim() : "");
		// The shell says "notepad.exe", agent-desktop "notepad": one key for both.
		const key = (app: string) => `desktop:${app.toLowerCase().replace(/\.exe$/, "")}`;
		const appKey = (window: KnownWindow | undefined) => key(window?.app ?? "unknown app");
		switch (tool) {
			case "desktop_act": {
				const ref = str("ref");
				let entry: SnapshotEntry | undefined;
				try {
					entry = state.entryFor(ref);
				} catch {}
				const action = (ACTIONS as readonly string[]).includes(str("action")) ? (str("action") as Action) : undefined;
				const verb = action ? ACTION_VERB[action] : str("action") || "Act on";
				const what = entry?.labels.get(ref) ?? ref;
				const value = action === "type" || action === "set_value" || action === "select" ? ` to ${JSON.stringify(clip(str("text"), 60))}` : "";
				const where = entry ? ` in ${windowName(entry.window)}` : "";
				return { summary: `${verb} ${what}${value}${where}`, allowKey: appKey(entry?.window), coverable: true };
			}
			case "desktop_press": {
				const window = str("window") ? state.windows.get(str("window")) : undefined;
				return {
					summary: `Press ${str("keys")} in ${window ? windowName(window) : "the window you were in"}`,
					allowKey: appKey(window),
					// Without a window we don't know the app yet, so "always" can't cover it.
					coverable: !!window,
				};
			}
			case "desktop_window": {
				const action = str("action");
				if (action === "launch") return { summary: `Launch ${str("app")}`, allowKey: key(str("app")), coverable: true };
				const window = str("window") ? state.windows.get(str("window")) : undefined;
				const verb = `${action[0]?.toUpperCase() ?? ""}${action.slice(1)}`;
				return { summary: `${verb} ${window ? windowName(window) : "the window you were in"}`, allowKey: appKey(window), coverable: !!window };
			}
		}
		return undefined;
	};

	const glance: DesktopTools["glance"] = async (target, signal) => {
		if (!WINDOW_ID.test(target.id)) return undefined;
		const window: KnownWindow = { ...target, chromium: false };
		state.windows.set(window.id, window);
		try {
			const result = await state.observe({ window, cap: GLANCE_CAP }, signal);
			return result.ok ? result.text : undefined;
		} catch (error) {
			if (error instanceof DesktopAborted) throw new Error("Stopped.");
			return undefined;
		}
	};

	return {
		tools: [observe, act, press, windows, windowTool, wait] as unknown as ReturnType<typeof defineTool>[],
		describe,
		glance,
	};
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new DesktopAborted());
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DesktopAborted());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
