// Computer use (desktop_* tools) against a fake agent-desktop CLI (fake-agent-desktop.ts): no
// desktop needed. The real CLI is exercised on Windows CI by desktop-e2e.ts.
import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Request } from "../src/protocol.ts";
import { ShellRequests } from "../src/requests.ts";
import { cliRunner, type DesktopRunner, parseEnvelope } from "../src/tools/desktop/cli.ts";
import { actionArgs, desktopTools } from "../src/tools/desktop/index.ts";
import { outline, renderError } from "../src/tools/desktop/render.ts";
import { type AnyTool, agentTools } from "../src/tools/index.ts";
import { DECLINED, policyFrom } from "../src/tools/permission.ts";
import { removeTempDirs, tempDir } from "./harness.ts";

afterAll(removeTempDirs);

const FAKE = join(import.meta.dir, "fake-agent-desktop.ts");
const WINKU_PID = 4242;

interface Rig {
	dir: string;
	run: DesktopRunner;
	sent: Request[];
	requests: ShellRequests;
	tools: Map<string, AnyTool>;
	calls: () => { args: string[]; stdin?: string }[];
	/** Answer screen_target with this (or an error when undefined). */
	target: { windowId: string; app?: string; windowTitle?: string; chromium: boolean } | undefined;
	askBeforeRunning: boolean;
	decisions: string[];
	permissionAsks: Record<string, unknown>[];
}

function rig(): Rig {
	const dir = tempDir("winku-desktop-");
	const r = {
		dir,
		run: cliRunner(process.execPath, dir, ["run", FAKE]),
		sent: [] as Request[],
		target: { windowId: "w-1001", app: "notepad.exe", windowTitle: "Untitled - Notepad", chromium: false },
		askBeforeRunning: false,
		decisions: [] as string[],
		permissionAsks: [] as Record<string, unknown>[],
		calls: () =>
			readFileSync(join(dir, "calls.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l)),
	} as Rig;
	r.requests = new ShellRequests((request) => {
		r.sent.push(request);
		queueMicrotask(() => {
			if (request.method === "screen_target")
				r.requests.handle(
					r.target
						? { type: "response", id: request.id, ok: true, data: r.target }
						: { type: "response", id: request.id, ok: false, error: "no window" },
				);
			if (request.method === "screen_capture")
				r.requests.handle({
					type: "response",
					id: request.id,
					ok: true,
					data: { app: r.target?.app, windowTitle: r.target?.windowTitle, windowId: r.target?.windowId, chromium: r.target?.chromium, text: "uia text" },
				});
			if (request.method === "permission") {
				r.permissionAsks.push(request.params as unknown as Record<string, unknown>);
				r.requests.handle({ type: "response", id: request.id, ok: true, data: { decision: r.decisions.shift() ?? "deny" } });
			}
		});
	});
	const list = agentTools({
		home: dir,
		shells: { powershell: false, bash: undefined },
		ripgrep: false,
		policy: () => policyFrom(r.askBeforeRunning, []),
		requests: r.requests,
		replyId: () => "p1",
		scheduledRun: () => undefined,
		spoken: () => false,
		supportsImages: () => false,
		searchKey: () => undefined,
		desktop: { run: (a, o) => r.run(a, o), ownPids: [WINKU_PID] },
	});
	r.tools = new Map(list.map((t) => [t.name, t]));
	return r;
}

async function call(r: Rig, name: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
	const tool = r.tools.get(name);
	if (!tool) throw new Error(`no tool ${name}`);
	const result = await tool.execute("call-1", params, signal, undefined, undefined as never);
	return (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
}

const T = 30_000;

test("the runner parses one envelope and reports garbage as INTERNAL", async () => {
	expect(parseEnvelope('{"ok":true,"data":{"a":1}}\n', 0)).toEqual({ ok: true, data: { a: 1 } });
	expect(parseEnvelope("", 1, "boom\n").error).toMatchObject({ code: "INTERNAL", message: "agent-desktop gave no result (boom)" });
	const r = rig();
	const { envelope, ms } = await r.run(["garbage"]);
	expect(envelope.ok).toBe(false);
	expect(envelope.error?.code).toBe("INTERNAL");
	expect(ms).toBeGreaterThan(0);
}, T);

test("the runner kills the process on abort and on timeout", async () => {
	const r = rig();
	const controller = new AbortController();
	const started = performance.now();
	const pending = r.run(["slow"], { signal: controller.signal });
	setTimeout(() => controller.abort(), 300);
	await expect(pending).rejects.toThrow("Stopped");
	expect(performance.now() - started).toBeLessThan(5_000);
	const timed = await r.run(["slow"], { timeoutMs: 500 });
	expect(timed.envelope.error?.code).toBe("TIMEOUT");
}, T);

test("desktop tools are offered only with agent-desktop, and the acting ones are gated", () => {
	const r = rig();
	expect([...r.tools.keys()].filter((n) => n.startsWith("desktop_"))).toEqual([
		"desktop_observe",
		"desktop_act",
		"desktop_press",
		"desktop_windows",
		"desktop_window",
		"desktop_wait",
	]);
	const without = agentTools({
		home: r.dir,
		shells: { powershell: false, bash: undefined },
		ripgrep: false,
		policy: () => policyFrom(false, []),
		requests: r.requests,
		replyId: () => undefined,
		scheduledRun: () => undefined,
		spoken: () => false,
		supportsImages: () => false,
		searchKey: () => undefined,
	});
	expect(without.some((t) => t.name.startsWith("desktop_"))).toBe(false);
});

test("observe → set_value → the fresh outline shows the text; text goes through stdin", async () => {
	const r = rig();
	const seen = await call(r, "desktop_observe", {});
	expect(r.sent.some((q) => q.method === "screen_target")).toBe(true);
	expect(seen).toContain('textfield "Text editor" @s1:e2');
	expect(seen).toContain("window w-1001");
	// Interactive, compact, and scoped to the target window, never the foreground.
	expect(r.calls()[0]?.args).toEqual(["snapshot", "-i", "--compact", "--timeout-ms", "4000", "--window-id", "w-1001"]);

	const done = await call(r, "desktop_act", { ref: "@s1:e2", action: "set_value", text: "hello from winku" });
	expect(done).toContain('Set textfield "Text editor": done.');
	expect(done).toContain("It landed and the result was checked.");
	expect(done).toContain('value="hello from winku"');
	const setValue = r.calls().find((c) => c.args[0] === "set-value");
	expect(setValue?.args).toEqual(["set-value", "--stdin", "--", "@s1:e2"]);
	expect(setValue?.stdin).toBe("hello from winku");
	expect(JSON.stringify(setValue?.args)).not.toContain("hello");
}, T);

test("type, double-click, right-click and focus use real input; the rest stay headless", () => {
	expect(actionArgs("type", "@s1:e2", { text: "-x" })).toEqual({ args: ["type", "--headed", "--stdin", "--", "@s1:e2"], stdin: "-x" });
	expect(actionArgs("click", "@s1:e3", {}).args).toEqual(["click", "--", "@s1:e3"]);
	expect(actionArgs("double_click", "@s1:e3", {}).args).toEqual(["double-click", "--headed", "--", "@s1:e3"]);
	expect(actionArgs("right_click", "@s1:e3", {}).args).toEqual(["right-click", "--headed", "--", "@s1:e3"]);
	expect(actionArgs("select", "@s1:e3", { text: "-5" }).args).toEqual(["select", "--", "@s1:e3", "-5"]);
	expect(actionArgs("scroll", "@s1:e3", { direction: "up", amount: 500 }).args).toEqual([
		"scroll",
		"--direction",
		"up",
		"--amount",
		"50",
		"--",
		"@s1:e3",
	]);
});

test("refs from elsewhere are refused before anything runs; stale refs get advice", async () => {
	const r = rig();
	await expect(call(r, "desktop_act", { ref: "@s9:e1", action: "click" })).rejects.toThrow("isn't from a snapshot taken in this conversation");
	await expect(call(r, "desktop_act", { ref: "e1", action: "click" })).rejects.toThrow("isn't a ref");
	await call(r, "desktop_observe", {});
	await call(r, "desktop_observe", {});
	await call(r, "desktop_observe", {});
	// s1 is now two snapshots old in the fake: STALE_REF.
	const stale = call(r, "desktop_act", { ref: "@s1:e3", action: "click" });
	await expect(stale).rejects.toThrow("STALE_REF");
	await expect(stale).rejects.toThrow("Observe again and use the new ref.");
	await expect(stale).rejects.toThrow("retrying is safe");
	// Something that may have landed: don't retry.
	await expect(call(r, "desktop_act", { ref: "@s3:e99", action: "click", observe: false })).rejects.toThrow("Do not repeat it blindly");
}, T);

test("Winku's own windows are never listed, observed or acted on", async () => {
	const r = rig();
	const list = await call(r, "desktop_windows", {});
	expect(list).toContain("w-1001 notepad");
	expect(list).toContain("[the user was here]");
	expect(list).not.toContain("w-2002");
	expect(list).not.toContain("w-3003");
	await expect(call(r, "desktop_observe", { window: "w-2002" })).rejects.toThrow("no window w-2002 that Winku may use");
	await expect(call(r, "desktop_press", { keys: "ctrl+s", window: "w-3003" })).rejects.toThrow("Winku may use");
	await expect(call(r, "desktop_window", { action: "launch", app: "winku.exe" })).rejects.toThrow("Winku itself");
	expect(r.calls().some((c) => c.args.includes("w-2002") || c.args.includes("w-3003"))).toBe(false);
	// No target window (the shell found none, or only Winku): nothing runs.
	r.target = undefined;
	await expect(call(r, "desktop_observe", {})).rejects.toThrow("Couldn't tell which window");
}, T);

test("a window too big for one look comes back as a skeleton with drill targets", async () => {
	const r = rig();
	await call(r, "desktop_observe", {});
	const state = JSON.parse(readFileSync(join(r.dir, "fake.json"), "utf8"));
	writeState(r, { ...state, extraButtons: 400 });
	const seen = await call(r, "desktop_observe", {});
	expect(seen.length).toBeLessThan(7_000);
	expect(seen).toContain('group "Lots" @s3:e4 (400 more inside)');
	expect(seen).toContain("shallow map");
	expect(r.calls().at(-1)?.args).toContain("--skeleton");
	const drill = await call(r, "desktop_observe", { root: "@s3:e4" });
	expect(drill).toContain("Drill-in of");
	expect(drill).toContain("more lines were cut");
}, T);

function writeState(r: Rig, state: unknown) {
	Bun.write(join(r.dir, "fake.json"), JSON.stringify(state));
}

test("press and window actions target the window by id", async () => {
	const r = rig();
	await call(r, "desktop_press", { keys: "Ctrl+S" });
	expect(r.calls().at(-1)?.args).toEqual(["press", "--headed", "--window-id", "w-1001", "--", "ctrl+s"]);
	const launched = await call(r, "desktop_window", { action: "launch", app: "notepad" });
	expect(launched).toContain("window w-5005");
	await call(r, "desktop_window", { action: "focus", window: "w-5005" });
	expect(r.calls().at(-1)?.args).toEqual(["focus-window", "--headed", "--window-id", "w-5005"]);
}, T);

test("Ask before running gates acting tools with a readable summary; observing is never gated", async () => {
	const r = rig();
	r.askBeforeRunning = true;
	await call(r, "desktop_observe", {});
	await call(r, "desktop_windows", {});
	expect(r.permissionAsks).toHaveLength(0);
	await expect(call(r, "desktop_act", { ref: "@s1:e2", action: "set_value", text: "hi" })).rejects.toThrow(DECLINED);
	expect(r.permissionAsks[0]).toMatchObject({
		tool: "desktop_act",
		summary: 'Set textfield "Text editor" to "hi" in notepad.exe "Untitled - Notepad"',
		allowKey: "desktop:notepad",
	});
	expect(r.calls().some((c) => c.args[0] === "set-value")).toBe(false);
	r.decisions.push("allow_once");
	await call(r, "desktop_press", { keys: "return", window: "w-1001" });
	expect(r.permissionAsks[1]).toMatchObject({ tool: "desktop_press", summary: 'Press return in notepad.exe "Untitled - Notepad"', allowKey: "desktop:notepad" });
}, T);

test("Esc stops a running action and a pause", async () => {
	const r = rig();
	const controller = new AbortController();
	const pause = call(r, "desktop_wait", { ms: 20_000 }, controller.signal);
	setTimeout(() => controller.abort(), 100);
	await expect(pause).rejects.toThrow("Stopped.");
}, T);

test("look_at_screen adds the controls, except in Chromium windows", async () => {
	const r = rig();
	const plain = await call(r, "look_at_screen", {});
	expect(plain).toContain("Window id: w-1001");
	expect(plain).toContain('Controls (refs for desktop_act):\nSnapshot of window w-1001');
	expect(plain).toContain("@s1:e2");
	const before = r.calls().length;
	r.target = { windowId: "w-1001", app: "chrome.exe", windowTitle: "Inbox", chromium: true };
	const chrome = await call(r, "look_at_screen", {});
	expect(r.calls().length).toBe(before);
	expect(chrome).toContain("Use desktop_observe if you need to operate this app");
}, T);

test("outline: one line per node, quiet states dropped, capped", () => {
	const tree = {
		role: "window",
		name: "W",
		children: [
			{ role: "group", children: [{ role: "button", name: "OK", ref_id: "@s1:e1", states: ["enabled", "focused"] }] },
			{ role: "text" },
		],
	};
	const out = outline(tree, 1000);
	expect(out.text).toBe('window "W"\n  group\n    button "OK" @s1:e1 [focused]');
	expect(out.labels.get("@s1:e1")).toBe('button "OK"');
	expect(outline(tree, 12).cut).toBe(2);
	expect(renderError("Click", { ok: false, error: { code: "PERM_DENIED", message: "no" } })).toContain("administrator");
});
