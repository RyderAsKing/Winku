// Computer use end to end on a real Windows desktop (CI's windows-build job), through the same
// desktop_* tool code the agent uses, with the real agent-desktop CLI:
//   launch Notepad → observe → set_value → observe again → type → observe again → Esc stops a wait,
// and measures per-call latency of the CLI against `agent-desktop mcp`.
// Run: WINKU_AGENT_DESKTOP_BIN=…\agent-desktop.exe bun run test/desktop-e2e.ts
// The shell's part (screen_target: the window before the bar) is played by this script.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellRequests } from "../src/requests.ts";
import { cliRunner, type DesktopRunner, findAgentDesktop } from "../src/tools/desktop/cli.ts";
import { desktopTools } from "../src/tools/desktop/index.ts";

const bin = findAgentDesktop();
if (!bin) throw new Error("Set WINKU_AGENT_DESKTOP_BIN to agent-desktop.exe");
const stateDir = mkdtempSync(join(tmpdir(), "winku-desktop-e2e-"));
const run0 = cliRunner(bin, stateDir);
const timings: Record<string, number[]> = {};
const run: DesktopRunner = async (args, options) => {
	const result = await run0(args, options);
	(timings[args[0] as string] ??= []).push(result.ms);
	return result;
};

let target = { windowId: "", app: "notepad.exe", windowTitle: "", chromium: false };
const requests: ShellRequests = new ShellRequests((request) => {
	queueMicrotask(() => {
		if (request.method === "screen_target") requests.handle({ type: "response", id: request.id, ok: true, data: target });
	});
});
const desktop = desktopTools({ run, requests, ownPids: [] });
const tool = (name: string) => {
	const found = desktop.tools.find((t) => t.name === name);
	if (!found) throw new Error(`no ${name}`);
	return found;
};
async function call(name: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
	const started = performance.now();
	const result = await tool(name).execute("e2e", params as never, signal, undefined, undefined as never);
	const text = (result.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
	console.log(`\n── ${name} ${JSON.stringify(params)} (${Math.round(performance.now() - started)} ms)\n${text.slice(0, 1500)}`);
	return text;
}
function check(ok: unknown, what: string): void {
	if (!ok) throw new Error(`FAILED: ${what}`);
	console.log(`ok: ${what}`);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

/** Per-call latency of `agent-desktop mcp` (one long-lived process) for the same commands. */
async function mcpLatency(command: string, args: Record<string, unknown>, n: number): Promise<number[]> {
	const child = spawn(bin as string, ["mcp"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, AGENT_DESKTOP_HOME: stateDir } });
	let buffer = "";
	const waiting = new Map<number, (v: unknown) => void>();
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line) continue;
			const message = JSON.parse(line) as { id?: number };
			if (message.id !== undefined) waiting.get(message.id)?.(message);
		}
	});
	let nextId = 0;
	const rpc = (method: string, params: unknown) =>
		new Promise<unknown>((resolve) => {
			const id = ++nextId;
			waiting.set(id, resolve);
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "winku-e2e", version: "0" } });
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const times: number[] = [];
	for (let i = 0; i < n; i++) {
		const started = performance.now();
		const reply = (await rpc("tools/call", { name: `desktop_${command.replace(/-/g, "_")}`, arguments: args })) as { error?: unknown };
		times.push(Math.round(performance.now() - started));
		if (reply.error) throw new Error(`mcp ${command}: ${JSON.stringify(reply.error)}`);
	}
	child.kill();
	return times;
}

try {
	// ── latency: one process per call vs the MCP server
	for (let i = 0; i < 5; i++) await run(["version"]);
	for (let i = 0; i < 5; i++) await run(["list-windows"]);
	const mcpVersion = await mcpLatency("version", {}, 5);
	const mcpList = await mcpLatency("list-windows", {}, 5);
	const latency = {
		cli_ms: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, { median: median(v), all: v }])),
		mcp_ms: { version: { median: median(mcpVersion), all: mcpVersion }, "list-windows": { median: median(mcpList), all: mcpList } },
	};
	console.log(`\nLATENCY ${JSON.stringify(latency)}`);

	// ── launch Notepad through the tool (gives its window id)
	const launched = await call("desktop_window", { action: "launch", app: "notepad" });
	const windowId = /window (w-\d+)/.exec(launched)?.[1];
	check(windowId, "launch returned Notepad's window id");
	const listed = await call("desktop_windows", {});
	target = { windowId: windowId as string, app: "notepad.exe", windowTitle: "Untitled - Notepad", chromium: false };
	check(listed.includes(windowId as string), "the window is listed");

	// ── observe the target (what the user was in), find the editor
	const seen = await call("desktop_observe", {});
	const editor = /^\s*(?:textfield|document|textarea|edit)\b[^\n]*?(@[A-Za-z0-9]+:e\d+)/m.exec(seen)?.[1];
	check(editor, "the outline has the text editor with a ref");

	// ── set_value (headless), verified by the outline that comes back and by a fresh observe
	const TEXT = "Hello from Winku e2e";
	const set = await call("desktop_act", { ref: editor, action: "set_value", text: TEXT });
	check(set.includes(TEXT), "set_value's result shows the new text");
	const again = await call("desktop_observe", {});
	check(again.includes(TEXT), "observing again shows the text");

	// ── type (real keystrokes) at the caret, verified by observing again
	const editor2 = /^\s*(?:textfield|document|textarea|edit)\b[^\n]*?(@[A-Za-z0-9]+:e\d+)/m.exec(again)?.[1];
	await call("desktop_act", { ref: editor2, action: "type", text: " typed", observe: false });
	const afterType = await call("desktop_observe", {});
	check(afterType.includes("typed"), "observing again shows the typed text");

	// ── the look_at_screen glance
	const glance = await desktop.glance({ id: windowId as string, app: "notepad.exe" }, undefined);
	check(glance?.includes("@"), "look_at_screen's glance lists refs");

	// ── Esc stops a running call (a wait for text that never comes)
	const controller = new AbortController();
	const started = performance.now();
	const waiting = call("desktop_wait", { text: "never-appears-xyz", ms: 20_000 }, controller.signal);
	setTimeout(() => controller.abort(), 1_000);
	const stopped = await waiting.then(
		() => false,
		(error) => String(error).includes("Stopped"),
	);
	check(stopped && performance.now() - started < 5_000, "Esc (abort) stops a running wait within a few seconds");

	console.log("\nPASS: computer use end to end");
} finally {
	// Close Notepad without saving.
	await run(["close-app", "--force", "--", "notepad"]).catch(() => {});
	rmSync(stateDir, { recursive: true, force: true });
}
