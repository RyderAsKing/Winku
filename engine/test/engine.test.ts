import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundMessage, OutboundMessage } from "../src/protocol.ts";

// Runs src/main.ts by default. Set WINKU_ENGINE_BIN to test a compiled binary instead.
const command = process.env.WINKU_ENGINE_BIN
	? [process.env.WINKU_ENGINE_BIN]
	: [process.execPath, "run", join(import.meta.dir, "../src/main.ts")];

async function runEngine(messages: (dataDir: string) => InboundMessage[]) {
	const root = mkdtempSync(join(tmpdir(), "winku-test-"));
	const home = join(root, "home");
	const dataDir = join(root, "data");
	mkdirSync(home);

	const proc = Bun.spawn(command, {
		cwd: root,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home },
	});
	for (const message of messages(dataDir)) proc.stdin.write(`${JSON.stringify(message)}\n`);
	proc.stdin.flush();

	const records: OutboundMessage[] = [];
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of proc.stdout) {
		buffer += decoder.decode(chunk, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			const record = JSON.parse(line) as OutboundMessage;
			records.push(record);
			if (record.type === "reply_end" || record.type === "error") {
				proc.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
				proc.stdin.end();
			}
		}
	}
	const exitCode = await proc.exited;
	return { records, exitCode, home, dataDir, stderr: await new Response(proc.stderr).text() };
}

test("streams one reply from the scripted model and exits cleanly", async () => {
	const { records, exitCode, stderr } = await runEngine((dataDir) => [
		{ type: "configure", dataDir, provider: "winku-faux", model: "faux-1" },
		{ type: "prompt", id: "p1", text: "hi there" },
	]);

	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	expect(records[0]).toMatchObject({ type: "hello", pi: "1.5.2" });
	expect(records[1]).toMatchObject({ type: "ready", provider: "winku-faux", model: "faux-1" });

	const deltas = records.filter((r) => r.type === "text_delta");
	expect(deltas.length).toBeGreaterThan(1);
	const end = records.at(-1);
	expect(end).toMatchObject({ type: "reply_end", id: "p1", aborted: false });
	if (end?.type !== "reply_end") throw new Error("unreachable");
	expect(end.text).toBe("Hello from winku-engine. You said: hi there");
	expect(deltas.map((d) => (d.type === "text_delta" ? d.delta : "")).join("")).toBe(end.text);
}, 30_000);

test("keeps its files in the data folder and never touches the home folder", async () => {
	const { home, dataDir } = await runEngine((dataDir) => [
		{ type: "configure", dataDir, provider: "winku-faux", model: "faux-1" },
		{ type: "prompt", id: "p1", text: "hi" },
	]);

	// From source, the bun runner itself may create ~/.bun. The compiled binary must leave home empty.
	const touched = readdirSync(home).filter((name) => process.env.WINKU_ENGINE_BIN || name !== ".bun");
	expect(touched).toEqual([]);
	expect(readdirSync(join(dataDir, "engine", "sessions")).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
}, 30_000);

test("reports an error for a prompt before configure", async () => {
	const { records } = await runEngine(() => [{ type: "prompt", id: "p1", text: "hi" }]);
	expect(records.at(-1)).toMatchObject({ type: "error", id: "p1", message: "Engine is not configured" });
}, 30_000);
