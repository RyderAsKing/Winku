import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryEntry, ModelInfo, OutboundMessage, ProviderInfo, TranscriptItem } from "../src/protocol.ts";
import { deltas, EngineProcess, removeTempDirs } from "./harness.ts";

const running: EngineProcess[] = [];
function start(): EngineProcess {
	const engine = EngineProcess.start();
	running.push(engine);
	return engine;
}
afterAll(removeTempDirs);
afterEach(async () => {
	for (const engine of running.splice(0)) {
		try {
			engine.proc.kill();
		} catch {}
	}
});

const T = 30_000;

test("streams one reply from the scripted model and exits cleanly", async () => {
	const engine = start();
	await engine.configure();
	const { end, records } = await engine.prompt("hi there");
	const { exitCode, stderr } = await engine.shutdown();

	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	expect(engine.records[0]).toMatchObject({ type: "hello", pi: "1.5.2" });
	expect(engine.records.find((r) => r.type === "ready")).toMatchObject({
		type: "ready",
		provider: "winku-faux",
		model: "faux-1",
		contextWindow: 200_000,
		supportsImages: true,
		thinking: "medium",
	});
	expect(records[0]).toMatchObject({ type: "thinking" });
	expect(end).toMatchObject({ aborted: false, text: "Hello from winku-engine. You said: hi there" });
	expect(deltas(records)).toBe(end.text);
	const context = engine.records.filter((r) => r.type === "context").at(-1);
	expect(context).toMatchObject({ type: "context", contextWindow: 200_000 });
	// The prompt itself gets exactly one Result.
	expect(engine.records.filter((r) => r.type === "result" && r.id === end.id)).toEqual([
		{ type: "result", id: end.id, ok: true, data: { steered: false } },
	]);
}, T);

test("keeps its files in the data folder and never touches the home folder", async () => {
	const engine = start();
	await engine.configure();
	await engine.prompt("hi");
	await engine.shutdown();

	// From source, the bun runner itself may create ~/.bun. The compiled binary must leave home empty.
	const touched = readdirSync(engine.home).filter((name) => process.env.WINKU_ENGINE_BIN || name !== ".bun");
	expect(touched).toEqual([]);
	const sessions = readdirSync(join(engine.dataDir, "engine", "sessions")).filter((f) => f.endsWith(".jsonl"));
	expect(sessions).toHaveLength(1);
	const pointer = JSON.parse(readFileSync(join(engine.dataDir, "engine", "current.json"), "utf8"));
	expect(pointer.sessionFile).toEndWith(sessions[0] as string);
	expect(existsSync(join(engine.dataDir, "engine", "auth.json"))).toBe(false);
	expect(existsSync(join(engine.dataDir, "engine", "models.json"))).toBe(false);
}, T);

test("rejects a prompt before configure", async () => {
	const engine = start();
	const result = await engine.call({ type: "prompt", text: "hi" });
	expect(result).toMatchObject({ ok: false, error: "Engine is not configured", errorKind: "config" });
	expect(engine.records.find((r) => r.type === "error")).toMatchObject({ errorKind: "config" });
	const transcript = await engine.call({ type: "transcript" });
	expect(transcript).toMatchObject({ ok: false, errorKind: "config" });
	await engine.shutdown();
}, T);

test("rejects configure with an unknown model without breaking", async () => {
	const engine = start();
	const result = await engine.call({ ...(await import("./harness.ts")).fauxConfig(engine.dataDir), main: { id: "nope", thinking: "off" }, provider: { kind: "catalog", id: "anthropic" } });
	expect(result).toMatchObject({ ok: false, errorKind: "config" });
	const unknown = await engine.call({ ...(await import("./harness.ts")).fauxConfig(engine.dataDir), provider: { kind: "catalog", id: "no-such" } });
	expect(unknown).toMatchObject({ ok: false, errorKind: "config" });
	await engine.shutdown();
}, T);

test("strips the mood tag from deltas and reports the mood", async () => {
	const engine = start();
	await engine.configure({
		faux: {
			tokensPerSecond: 400,
			replies: [{ text: "Sure thing! <mood:happy>" }, { text: "Odd one. <mood:grumpy>" }, { thinking: "hmm", text: "a<b and <mood:sad>\n" }],
		},
	});
	const first = await engine.prompt("one");
	expect(first.end).toMatchObject({ text: "Sure thing!", mood: "happy" });
	expect(deltas(first.records)).toBe("Sure thing!");
	expect(deltas(first.records)).not.toContain("<");

	const second = await engine.prompt("two");
	expect(second.end.text).toBe("Odd one.");
	expect(second.end.mood).toBeUndefined();
	expect(deltas(second.records)).toBe("Odd one.");

	const third = await engine.prompt("three");
	expect(third.end).toMatchObject({ text: "a<b and", mood: "sad" });

	const transcript = await engine.callOk<TranscriptItem[]>({ type: "transcript" });
	expect(transcript.filter((t) => t.kind === "assistant")).toMatchObject([
		{ text: "Sure thing!", mood: "happy" },
		{ text: "Odd one." },
		{ text: "a<b and", mood: "sad" },
	]);
	await engine.shutdown();
}, T);

test("the now line carries the clipboard note (kind and size only) and reads it back", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [{ echoUser: true }] } });
	const { end } = await engine.prompt("fix this", { now: { app: "notepad.exe", clipboard: "text, 120 words" } });
	expect(end.text).toBe('fix this\n\n<now app="notepad.exe" clipboard="text, 120 words"></now>\n[images:0]');
	const transcript = await engine.callOk<TranscriptItem[]>({ type: "transcript" });
	expect(transcript[0]).toMatchObject({ kind: "user", text: "fix this", now: { app: "notepad.exe", clipboard: "text, 120 words" } });
	await engine.shutdown();
}, T);

test("appends the now line to the user message and passes images through", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [{ echoUser: true }] } });
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
	const { end } = await engine.prompt("what is this?", {
		now: { app: "outlook.exe", windowTitle: 'Re: "lunch" <Bob>', selection: "see you at 12" },
		images: [{ data: png, mimeType: "image/png" }],
	});
	expect(end.text).toBe(
		'what is this?\n\n<now app="outlook.exe" window="Re: &quot;lunch&quot; &lt;Bob&gt;">see you at 12</now>\n[images:1]',
	);
	const transcript = await engine.callOk<TranscriptItem[]>({ type: "transcript" });
	expect(transcript[0]).toMatchObject({
		kind: "user",
		text: "what is this?",
		images: 1,
		now: { app: "outlook.exe", windowTitle: 'Re: "lunch" <Bob>', selection: "see you at 12" },
	});
	await engine.shutdown();
}, T);

test("a spoken reply's <say> blocks go to say events, the written part to text_delta", async () => {
	const engine = start();
	await engine.configure({
		faux: {
			replies: [
				{ echoUser: true },
				{ text: "<say>Let me check.</say>", toolCalls: [{ name: "no_such_tool", arguments: { why: "check" } }] },
				{ text: "<say>The timeout is now thirty seconds.</say>\n\nSet `timeout = 30` in `config.toml`. <mood:happy>" },
				{ text: "<say>It's twenty past three.</say> <mood:neutral>" },
				{ text: "<say>Not parsed here.</say> Typed." },
			],
		},
	});
	const asked = await engine.prompt("hi", { spoken: true, speak: "enough" });
	expect(asked.end.text).toBe('hi\n\n<now spoken="yes" speak="enough"></now>\n[images:0]');

	const { end, records } = await engine.prompt("fix the timeout", { speak: "enough" });
	expect(records.filter((r) => r.type === "say").map((r) => r.type === "say" && r.text)).toEqual([
		"Let me check.",
		"The timeout is now thirty seconds.",
	]);
	expect(end).toMatchObject({ text: "Set `timeout = 30` in `config.toml`.", mood: "happy" });
	expect(deltas(records)).toBe(end.text);
	// The first block is said before the written part starts.
	const firstSay = records.findIndex((r) => r.type === "say");
	expect(firstSay).toBeLessThan(records.findIndex((r) => r.type === "text_delta"));

	// Nothing written: the said text is the reply.
	const short = await engine.prompt("what time is it?", { speak: "brief" });
	expect(short.end).toMatchObject({ text: "It's twenty past three.", mood: "neutral" });
	expect(deltas(short.records)).toBe("It's twenty past three.");

	// Not asked to speak: tags are left alone.
	const typed = await engine.prompt("typed");
	expect(typed.records.some((r) => r.type === "say")).toBe(false);
	expect(typed.end.text).toBe("<say>Not parsed here.</say> Typed.");

	const transcript = await engine.callOk<TranscriptItem[]>({ type: "transcript" });
	const assistant = transcript.filter((t) => t.kind === "assistant").map((t) => t.kind === "assistant" && t.text);
	expect(assistant.slice(1, 4)).toEqual(["Let me check.", "Set `timeout = 30` in `config.toml`.", "It's twenty past three."]);
	await engine.shutdown();
}, T);

test("reports tool calls generically", async () => {
	const engine = start();
	await engine.configure({
		faux: { replies: [{ text: "Let me look.", toolCalls: [{ name: "no_such_tool", arguments: { why: "check" } }] }, { text: "Done. <mood:neutral>" }] },
	});
	const { end, records } = await engine.prompt("look");
	const toolStart = records.find((r) => r.type === "tool_start");
	const toolEnd = records.find((r) => r.type === "tool_end");
	expect(toolStart).toMatchObject({ name: "no_such_tool", summary: "check" });
	// An unknown tool fails; the summary falls back to its first string argument.
	expect(toolEnd).toMatchObject({ ok: false, summary: "check" });
	expect(end).toMatchObject({ text: "Let me look.\n\nDone.", mood: "neutral" });
	expect(deltas(records)).toBe(end.text);
	const transcript = await engine.callOk<TranscriptItem[]>({ type: "transcript" });
	expect(transcript.map((t) => t.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
	expect(transcript[2]).toMatchObject({ name: "no_such_tool", summary: "check", ok: false });
	await engine.shutdown();
}, T);

test("maps model errors to an errorKind", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [{ error: "401 Unauthorized: invalid x-api-key" }, { error: "fetch failed: ECONNREFUSED" }] } });
	const first = await engine.prompt("hi");
	expect(first.records.find((r) => r.type === "error")).toMatchObject({ errorKind: "auth" });
	expect(first.end).toMatchObject({ aborted: false, text: "" });
	const second = await engine.prompt("hi");
	expect(second.records.find((r) => r.type === "error")).toMatchObject({ errorKind: "network" });
	const transcript = await engine.callOk<TranscriptItem[]>({ type: "transcript" });
	expect(transcript.filter((t) => t.kind === "error")).toMatchObject([{ errorKind: "auth" }, { errorKind: "network" }]);
	await engine.shutdown();
}, T);

test("abort stops the reply", async () => {
	const engine = start();
	await engine.configure({ faux: { tokensPerSecond: 20, replies: [{ text: "word ".repeat(200) }] } });
	const from = engine.records.length;
	engine.send({ type: "prompt", id: "slow", text: "talk" });
	await engine.waitFor((r) => r.type === "text_delta" && r.id === "slow", from);
	const result = await engine.call({ type: "abort" });
	expect(result.ok).toBe(true);
	const end = await engine.waitFor((r) => r.type === "reply_end" && r.id === "slow", from);
	expect(end).toMatchObject({ aborted: true });
	// Still usable afterwards.
	const next = await engine.prompt("again");
	expect(next.end.aborted).toBe(false);
	await engine.shutdown();
}, T);

test("a prompt while streaming steers the reply instead of waiting", async () => {
	const engine = start();
	await engine.configure({
		faux: { tokensPerSecond: 200, replies: [{ text: "first reply ".repeat(10) }, { echoUser: true }] },
	});
	const from = engine.records.length;
	engine.send({ type: "prompt", id: "a", text: "one" });
	await engine.waitFor((r) => r.type === "text_delta" && r.id === "a", from);
	engine.send({ type: "prompt", id: "b", text: "two" });
	const resultB = await engine.waitFor((r) => r.type === "result" && r.id === "b", from);
	expect(resultB).toMatchObject({ ok: true, data: { steered: true } });
	const endB = await engine.waitFor((r) => r.type === "reply_end" && r.id === "b", from);
	const endA = engine.records.find((r) => r.type === "reply_end" && r.id === "a");
	expect(endA).toMatchObject({ text: "first reply ".repeat(10).trimEnd(), aborted: false });
	// The model's next call saw the steering message.
	expect(endB).toMatchObject({ aborted: false });
	expect((endB as { text: string }).text).toContain("two");
	expect(engine.records.indexOf(endA as OutboundMessage)).toBeLessThan(engine.records.indexOf(endB));
	await engine.shutdown();
}, T);

test("a steer during a tool call arrives after the tool result, before the next model call", async () => {
	const engine = start();
	await engine.configure({
		faux: {
			tokensPerSecond: 50,
			replies: [{ text: "looking ".repeat(6), toolCalls: [{ name: "ls", arguments: { path: "." } }] }, { echoUser: true }],
		},
	});
	const from = engine.records.length;
	engine.send({ type: "prompt", id: "a", text: "list things" });
	await engine.waitFor((r) => r.type === "text_delta" && r.id === "a", from);
	engine.send({ type: "prompt", id: "b", text: "actually the other folder" });
	const toolEnd = await engine.waitFor((r) => r.type === "tool_end", from);
	expect(toolEnd).toMatchObject({ id: "a", ok: true });
	const endB = await engine.waitFor((r) => r.type === "reply_end" && r.id === "b", from);
	expect((endB as { text: string }).text).toContain("actually the other folder");
	expect(engine.records.indexOf(toolEnd)).toBeLessThan(engine.records.indexOf(endB));
	await engine.shutdown();
}, T);

test("two steers in one step are both delivered, in order", async () => {
	const engine = start();
	await engine.configure({ faux: { tokensPerSecond: 200, replies: [{ text: "first reply ".repeat(10) }, { echoUser: true }] } });
	const from = engine.records.length;
	engine.send({ type: "prompt", id: "a", text: "one" });
	await engine.waitFor((r) => r.type === "text_delta" && r.id === "a", from);
	engine.send({ type: "prompt", id: "b", text: "two" });
	engine.send({ type: "prompt", id: "c", text: "three" });
	const endC = await engine.waitFor((r) => r.type === "reply_end" && r.id === "c", from);
	const endB = engine.records.find((r) => r.type === "reply_end" && r.id === "b");
	expect(endB).toMatchObject({ aborted: false });
	expect(endC).toMatchObject({ aborted: false });
	expect((endC as { text: string }).text).toContain("three");
	// One model call answered both: no reply was left for a later turn.
	const ends = engine.records.slice(from).filter((r) => r.type === "reply_end");
	expect(ends.map((r) => (r as { id: string }).id)).toEqual(["a", "b", "c"]);
	await engine.shutdown();
}, T);

test("Esc with a steer pending ends every reply aborted", async () => {
	const engine = start();
	await engine.configure({ faux: { tokensPerSecond: 50, replies: [{ text: "first reply ".repeat(20) }] } });
	const from = engine.records.length;
	engine.send({ type: "prompt", id: "a", text: "one" });
	await engine.waitFor((r) => r.type === "text_delta" && r.id === "a", from);
	engine.send({ type: "prompt", id: "b", text: "two" });
	await engine.waitFor((r) => r.type === "result" && r.id === "b", from);
	engine.send({ type: "abort" });
	const endB = await engine.waitFor((r) => r.type === "reply_end" && r.id === "b", from);
	const endA = engine.records.find((r) => r.type === "reply_end" && r.id === "a");
	expect(endA).toMatchObject({ aborted: true });
	expect(endB).toMatchObject({ aborted: true });
	await engine.shutdown();
}, T);

test("clear, undo_clear, history and restore", async () => {
	const engine = start();
	await engine.configure();
	await engine.prompt("first thread message");
	const firstId = (await engine.callOk<HistoryEntry[]>({ type: "history_list" }))[0]?.id as string;

	let from = engine.records.length;
	const { undoToken } = await engine.callOk<{ undoToken: string }>({ type: "clear" });
	expect(await engine.waitFor((r) => r.type === "thread_changed", from)).toMatchObject({ reason: "clear" });
	expect(await engine.callOk({ type: "transcript" })).toEqual([]);

	from = engine.records.length;
	await engine.callOk({ type: "undo_clear", undoToken });
	expect(await engine.waitFor((r) => r.type === "thread_changed", from)).toMatchObject({ reason: "undo_clear", sessionId: firstId });
	expect((await engine.callOk<TranscriptItem[]>({ type: "transcript" })).map((t) => t.kind)).toEqual(["user", "assistant"]);
	expect(await engine.call({ type: "undo_clear", undoToken })).toMatchObject({ ok: false });

	// Clear for real and talk in the new thread.
	await engine.callOk({ type: "clear" });
	await new Promise((r) => setTimeout(r, 15));
	await engine.prompt("second thread about bananas");
	const list = await engine.callOk<HistoryEntry[]>({ type: "history_list" });
	expect(list).toHaveLength(2);
	expect(list[0]).toMatchObject({ kind: "thread", current: true, title: "second thread about bananas", messageCount: 2 });
	expect(list[1]).toMatchObject({ id: firstId, current: false, title: "first thread message" });
	expect((await engine.callOk<HistoryEntry[]>({ type: "history_list", query: "BANANAS" })).map((e) => e.title)).toEqual([
		"second thread about bananas",
	]);
	const old = await engine.callOk<TranscriptItem[]>({ type: "history_read", entryId: firstId });
	expect(old[0]).toMatchObject({ kind: "user", text: "first thread message" });
	expect(await engine.call({ type: "history_read", entryId: "missing" })).toMatchObject({ ok: false });

	from = engine.records.length;
	await engine.callOk({ type: "history_restore", entryId: firstId });
	expect(await engine.waitFor((r) => r.type === "thread_changed", from)).toMatchObject({ reason: "restore", sessionId: firstId });
	const after = await engine.callOk<HistoryEntry[]>({ type: "history_list" });
	expect(after.find((e) => e.current)?.id).toBe(firstId);
	expect(after).toHaveLength(2);
	await engine.prompt("back again");
	expect((await engine.callOk<TranscriptItem[]>({ type: "transcript" })).filter((t) => t.kind === "user")).toHaveLength(2);
	await engine.shutdown();
}, T);

test("lists action log entries in history", async () => {
	const engine = start();
	await engine.configure();
	await engine.prompt("hello");
	writeFileSync(
		join(engine.dataDir, "engine", "actions.jsonl"),
		`${JSON.stringify({ id: "act1", name: "Rewrite", selection: "teh cat", text: "the cat", at: Date.now() + 1000 })}\n`,
	);
	const list = await engine.callOk<HistoryEntry[]>({ type: "history_list" });
	expect(list[0]).toMatchObject({ id: "act1", kind: "action", title: "Rewrite: teh cat", current: false });
	expect(await engine.callOk({ type: "history_read", entryId: "act1" })).toMatchObject([{ kind: "user" }, { kind: "assistant", text: "the cat" }]);
	await engine.shutdown();
}, T);

test("continues the current thread after a restart", async () => {
	const engine = start();
	await engine.configure();
	await engine.prompt("remember me");
	await engine.callOk({ type: "clear" });
	await engine.prompt("newest thread");
	await engine.shutdown();

	const again = engine.restart();
	running.push(again);
	await again.configure();
	const transcript = await again.callOk<TranscriptItem[]>({ type: "transcript" });
	expect(transcript[0]).toMatchObject({ kind: "user", text: "newest thread" });
	expect(await again.callOk<HistoryEntry[]>({ type: "history_list" })).toHaveLength(2);
	await again.shutdown();
}, T);

test("system prompt stays frozen until clear; re-configure keeps the thread", async () => {
	const engine = start();
	const echo = { echoSystemPrompt: true };
	await engine.configure({ assistantStyle: "Talk like a pirate.", faux: { replies: [echo, echo, echo] } });
	const first = await engine.prompt("p1");
	expect(first.end.text).toContain("Talk like a pirate.");

	// Re-configure: new style and thinking level. Thread and frozen prompt survive.
	await engine.configure({ assistantStyle: "Be formal.", main: { id: "faux-2", thinking: "high" }, faux: { replies: [echo, echo] } });
	const ready = engine.records.filter((r) => r.type === "ready").at(-1);
	expect(ready).toMatchObject({ model: "faux-2", thinking: "high" });
	const second = await engine.prompt("p2");
	expect(second.end.text).toBe(first.end.text);
	expect((await engine.callOk<TranscriptItem[]>({ type: "transcript" })).filter((t) => t.kind === "user")).toHaveLength(2);

	await engine.callOk({ type: "clear" });
	const third = await engine.prompt("p3");
	expect(third.end.text).toContain("Be formal.");
	expect(third.end.text).not.toContain("pirate");
	await engine.shutdown();
}, T);

test("a restarted thread keeps the prompt it started with", async () => {
	const engine = start();
	const echo = { echoSystemPrompt: true };
	await engine.configure({ assistantStyle: "Style one.", faux: { replies: [echo] } });
	const first = await engine.prompt("p1");
	await engine.shutdown();
	const again = engine.restart();
	running.push(again);
	await again.configure({ assistantStyle: "Style two.", faux: { replies: [echo] } });
	expect((await again.prompt("p2")).end.text).toBe(first.end.text);
	await again.shutdown();
}, T);

test("set_thinking changes main and quick levels", async () => {
	const engine = start();
	await engine.configure();
	let from = engine.records.length;
	expect(await engine.callOk({ type: "set_thinking", role: "main", level: "low" })).toEqual({ level: "low" });
	expect(await engine.waitFor((r) => r.type === "thinking_changed", from)).toEqual({ type: "thinking_changed", role: "main", level: "low" });
	from = engine.records.length;
	await engine.callOk({ type: "set_thinking", role: "quick", level: "high" });
	expect(await engine.waitFor((r) => r.type === "thinking_changed", from)).toEqual({ type: "thinking_changed", role: "quick", level: "high" });
	await engine.shutdown();
}, T);

test("compaction emits start/end, a context event and a transcript row", async () => {
	const engine = start();
	const long = "lorem ipsum dolor sit amet ".repeat(120);
	await engine.configure({
		compactionReserveTokens: 1000,
		faux: { contextWindow: 3000, keepRecentTokens: 500, tokensPerSecond: 1_000_000, replies: [{ text: long }, { text: long }, { text: long }, { text: "Summary of the chat." }, { text: "short" }] },
	});
	await engine.prompt("one");
	await engine.prompt("two");
	await engine.prompt("three");
	// Over the threshold now (window 3000 - reserve 1000); pi compacts before the next request.
	await engine.prompt("four");
	const compactionStart = await engine.waitFor((r) => r.type === "compaction_start", 0);
	expect(compactionStart).toMatchObject({ reason: "threshold" });
	const end = await engine.waitFor((r) => r.type === "compaction_end", 0);
	expect(end).toMatchObject({ ok: true });
	expect(engine.records.slice(engine.records.indexOf(end)).some((r) => r.type === "context")).toBe(true);
	const transcript = await engine.callOk<TranscriptItem[]>({ type: "transcript" });
	expect(transcript.some((t) => t.kind === "compaction")).toBe(true);
	await engine.shutdown();
}, T);

test("list_providers, list_models and test_connection for the catalog", async () => {
	const engine = start();
	const providers = await engine.callOk<ProviderInfo[]>({ type: "list_providers" });
	expect(providers.find((p) => p.id === "anthropic")).toMatchObject({ name: "Anthropic", keyUrl: expect.any(String) });
	expect(providers.some((p) => p.id === "winku-faux")).toBe(false);

	const models = await engine.callOk<ModelInfo[]>({ type: "list_models", provider: { kind: "catalog", id: "anthropic" } });
	expect(models.length).toBeGreaterThan(0);
	expect(models[0]).toMatchObject({ supportsImages: expect.any(Boolean), contextWindow: expect.any(Number) });
	expect(models[0]?.thinkingLevels[0]).toBe("off");

	expect(
		await engine.callOk({ type: "test_connection", provider: { kind: "catalog", id: "winku-faux" }, model: "faux-1" }),
	).toEqual({ ok: true, supportsImages: true });
	expect(
		await engine.callOk({
			type: "test_connection",
			provider: { kind: "catalog", id: "winku-faux" },
			model: "faux-1",
			faux: { replies: [{ error: "401 invalid api key" }] },
		}),
	).toMatchObject({ ok: false, errorKind: "auth" });
	await engine.shutdown();
}, T);

/** A tiny OpenAI-compatible server: /models, streaming chat completions, rejects images. */
function fakeOpenAI() {
	const seen: { auth: string | null; body: unknown }[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/v1/models") {
				if (request.headers.get("authorization") !== "Bearer sk-test") return new Response("no", { status: 401 });
				return Response.json({ object: "list", data: [{ id: "llama-3" }, { id: "qwen", context_length: 65536 }] });
			}
			if (url.pathname === "/v1/chat/completions") {
				const body = (await request.json()) as { messages: { content: unknown }[] };
				seen.push({ auth: request.headers.get("authorization"), body });
				if (JSON.stringify(body.messages).includes("image_url")) {
					return Response.json({ error: { message: "image input not supported" } }, { status: 400 });
				}
				const chunk = (delta: object, finish: string | null = null) =>
					`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "llama-3", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
				const sse = `${chunk({ role: "assistant", content: "" })}${chunk({ content: "ok from " })}${chunk({ content: "custom <mood:happy>" })}${chunk({}, "stop")}data: [DONE]\n\n`;
				return new Response(sse, { headers: { "content-type": "text/event-stream" } });
			}
			return new Response("not found", { status: 404 });
		},
	});
	return { server, seen, baseUrl: `http://127.0.0.1:${server.port}/v1` };
}

test("custom OpenAI-compatible endpoint: list_models, test_connection, configure and prompt", async () => {
	const fake = fakeOpenAI();
	try {
		const engine = start();
		const provider = { kind: "custom", baseUrl: fake.baseUrl, models: [] };
		const models = await engine.callOk<ModelInfo[]>({ type: "list_models", provider, apiKey: "sk-test" });
		expect(models).toEqual([
			{ id: "llama-3", name: "llama-3", supportsImages: false, contextWindow: 32768, thinkingLevels: ["off"] },
			{ id: "qwen", name: "qwen", supportsImages: false, contextWindow: 65536, thinkingLevels: ["off"] },
		]);
		expect(await engine.call({ type: "list_models", provider, apiKey: "wrong" })).toMatchObject({ ok: false, errorKind: "auth" });
		expect(
			await engine.call({ type: "list_models", provider: { ...provider, baseUrl: "http://127.0.0.1:1/v1" } }),
		).toMatchObject({ ok: false, errorKind: "network" });

		expect(await engine.callOk({ type: "test_connection", provider, apiKey: "sk-test", model: "llama-3" })).toEqual({
			ok: true,
			supportsImages: false,
		});

		await engine.callOk({
			type: "configure",
			dataDir: engine.dataDir,
			provider: { kind: "custom", baseUrl: fake.baseUrl, models: [{ id: "llama-3", supportsImages: false, contextWindow: 8192 }] },
			apiKey: "sk-test",
			main: { id: "llama-3", thinking: "medium" },
			askBeforeRunning: false,
			alwaysAllow: [],
			assistantStyle: "",
		});
		expect(engine.records.find((r) => r.type === "ready")).toMatchObject({
			provider: "custom",
			model: "llama-3",
			contextWindow: 8192,
			supportsImages: false,
			thinking: "off",
			thinkingLevels: ["off"],
		});
		const { end } = await engine.prompt("hello");
		expect(end).toMatchObject({ text: "ok from custom", mood: "happy", aborted: false });
		expect(fake.seen.at(-1)?.auth).toBe("Bearer sk-test");
		await engine.shutdown();
		// The key never reaches the disk.
		const files = readdirSync(join(engine.dataDir, "engine"), { recursive: true }) as string[];
		for (const file of files) {
			const path = join(engine.dataDir, "engine", file);
			if (file.endsWith(".json") || file.endsWith(".jsonl")) expect(readFileSync(path, "utf8")).not.toContain("sk-test");
		}
	} finally {
		fake.server.stop(true);
	}
}, T);

test("later-step commands, stats and results for every id", async () => {
	const engine = start();
	await engine.configure();
	expect(await engine.call({ type: "memory_undo", saveId: "s" })).toMatchObject({ ok: false, error: "Nothing to undo" });
	expect(await engine.call({ type: "now_line" })).toMatchObject({ ok: false, error: 'Unknown command "now_line"' });
	const stats = await engine.callOk<{ rssBytes: number; heapUsedBytes: number; uptimeMs: number }>({ type: "stats" });
	expect(stats.rssBytes).toBeGreaterThan(0);
	expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);
	expect(await engine.call({ type: "abort" })).toMatchObject({ ok: true });
	const results = engine.records.filter((r) => r.type === "result");
	expect(new Set(results.map((r) => (r.type === "result" ? r.id : ""))).size).toBe(results.length);
	const { exitCode } = await engine.shutdown();
	expect(exitCode).toBe(0);
}, T);

// ───────────────────────────── actions (step 4) ─────────────────────────────

const spec = (over: Record<string, unknown> = {}) => ({
	name: "Fix typos",
	prompt: "Fix the typos",
	output: "replace",
	useThreadContext: false,
	useVoice: false,
	...over,
});

type ActionEnd = Extract<OutboundMessage, { type: "action_end" }>;

/** Like engine.call, but with an id the test picks (run_action ids belong to the shell). */
async function callAs(engine: EngineProcess, id: string, message: Record<string, unknown>) {
	const from = engine.records.length;
	engine.send({ ...message, id });
	return engine.waitFor<Extract<OutboundMessage, { type: "result" }>>((r) => r.type === "result" && r.id === id, from);
}

async function action(engine: EngineProcess, id: string, extra: Record<string, unknown> = {}) {
	const from = engine.records.length;
	const result = await callAs(engine, id, { type: "run_action", action: spec(), selection: "teh cat", ...extra });
	const end = await engine.waitFor<ActionEnd>((r) => r.type === "action_end" && r.id === id, from);
	const mine = engine.records.slice(from).filter((r) => "id" in r && r.id === id);
	return { result, end, records: mine };
}

test("replace streams action_delta then action_end and stays out of the thread", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [{ text: "hi" }, { text: "the cat" }] } });
	await engine.prompt("hello");
	const before = await engine.callOk<TranscriptItem[]>({ type: "transcript" });
	const { result, end, records } = await action(engine, "action-1");
	expect(result).toMatchObject({ ok: true, data: { steered: false } });
	expect(end).toMatchObject({ text: "the cat", output: "replace", aborted: false });
	expect(records.filter((r) => r.type === "action_delta").map((r) => (r as { delta: string }).delta).join("")).toBe("the cat");
	expect(records.some((r) => r.type === "reply_end" || r.type === "text_delta")).toBe(false);
	expect(await engine.callOk<TranscriptItem[]>({ type: "transcript" })).toEqual(before);
	await engine.shutdown();
}, T);

test("show returns output show and is not added to the thread", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [{ text: "**Cat**: an animal." }] } });
	const { end } = await action(engine, "action-2", { action: spec({ output: "show", name: "Explain" }) });
	expect(end).toMatchObject({ text: "**Cat**: an animal.", output: "show", aborted: false });
	expect(await engine.callOk<TranscriptItem[]>({ type: "transcript" })).toEqual([]);
	await engine.shutdown();
}, T);

test("finished actions are logged and show up in history", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [{ text: "the cat" }] } });
	await action(engine, "action-3");
	const lines = readFileSync(join(engine.dataDir, "engine", "actions.jsonl"), "utf8").trim().split("\n");
	expect(lines).toHaveLength(1);
	expect(JSON.parse(lines[0] as string)).toMatchObject({ id: "action-3", name: "Fix typos", selection: "teh cat", text: "the cat", output: "replace" });
	const list = await engine.callOk<HistoryEntry[]>({ type: "history_list" });
	expect(list.find((e) => e.id === "action-3")).toMatchObject({ kind: "action", title: "Fix typos: teh cat" });
	expect(await engine.callOk({ type: "history_read", entryId: "action-3" })).toMatchObject([
		{ kind: "user", text: "Fix typos: teh cat" },
		{ kind: "assistant", text: "the cat" },
	]);
	await engine.shutdown();
}, T);

test("useThreadContext sends recent thread text; without it nothing is sent", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [{ text: "ok" }, { echoUser: true }, { echoUser: true }] } });
	await engine.prompt("my dog is called Rex");
	const withContext = await action(engine, "action-4", { action: spec({ useThreadContext: true }) });
	expect(withContext.end.text).toContain("my dog is called Rex");
	expect(withContext.end.text).toContain("Fix the typos");
	expect(withContext.end.text).toContain("teh cat");
	const without = await action(engine, "action-5");
	expect(without.end.text).not.toContain("Rex");
	expect(without.end.text).toContain("teh cat");
	await engine.shutdown();
}, T);

test("useVoice adds the named voice profile to the instructions, else the default profile", async () => {
	const engine = start();
	const echo = { echoSystemPrompt: true };
	await engine.configure({ assistantStyle: "Dry wit.", defaultVoiceProfile: "casual", faux: { replies: [echo, echo, echo, echo] } });
	writeFileSync(join(engine.dataDir, "voice", "work.md"), "Short, formal, no emoji.\n");
	const voiced = await action(engine, "action-6", { action: spec({ useVoice: true }), voiceProfile: "work" });
	expect(voiced.end.text).toContain("Short, formal, no emoji.");
	expect(voiced.end.text).toContain("Dry wit.");
	expect(voiced.end.text).toContain("no preamble");
	const off = await action(engine, "action-7", { voiceProfile: "work" });
	expect(off.end.text).not.toContain("voice_profile");
	const casual = readFileSync(join(engine.dataDir, "voice", "casual.md"), "utf8").trim();
	const fallback = await action(engine, "action-8", { action: spec({ useVoice: true }) });
	expect(fallback.end.text).toContain(casual);
	const missing = await action(engine, "action-9", { action: spec({ useVoice: true }), voiceProfile: "../settings" });
	expect(missing.end.text).toContain(casual);
	await engine.shutdown();
}, T);

test("actions use the Quick model and its thinking level, else Main", async () => {
	const engine = start();
	await engine.configure({
		quick: { id: "faux-2", thinking: "low" },
		faux: { replies: [{ echoModel: true }, { echoModel: true }] },
	});
	expect((await action(engine, "action-9")).end.text).toBe("faux-2 reasoning=low");
	await engine.shutdown();

	const plain = start();
	await plain.configure({ faux: { replies: [{ echoModel: true }] } });
	expect((await action(plain, "action-10")).end.text).toBe("faux-1 reasoning=off");
	await plain.shutdown();
}, T);

test("the mood tag is stripped from action output", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [{ text: "the cat <mood:happy>" }] } });
	const { end, records } = await action(engine, "action-11");
	expect(end.text).toBe("the cat");
	expect(JSON.stringify(records)).not.toContain("mood");
	await engine.shutdown();
}, T);

test("a failing action sends error then action_end aborted, and is not logged", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [{ error: "401 Unauthorized: invalid x-api-key" }] } });
	const { end, records } = await action(engine, "action-12");
	expect(end).toMatchObject({ text: "", aborted: true, output: "replace" });
	const types = records.map((r) => r.type);
	expect(types.indexOf("error")).toBeGreaterThanOrEqual(0);
	expect(types.indexOf("error")).toBeLessThan(types.indexOf("action_end"));
	expect(records.find((r) => r.type === "error")).toMatchObject({ errorKind: "auth" });
	expect(existsSync(join(engine.dataDir, "engine", "actions.jsonl"))).toBe(false);
	await engine.shutdown();
}, T);

test("abort stops a running action", async () => {
	const engine = start();
	await engine.configure({ faux: { tokensPerSecond: 20, replies: [{ text: "word ".repeat(200) }] } });
	const from = engine.records.length;
	engine.send({ type: "run_action", id: "action-13", action: spec(), selection: "x" });
	await engine.waitFor((r) => r.type === "action_delta" && r.id === "action-13", from);
	expect(await engine.call({ type: "abort" })).toMatchObject({ ok: true });
	expect(await engine.waitFor((r) => r.type === "action_end" && r.id === "action-13", from)).toMatchObject({ aborted: true, text: "" });
	expect(existsSync(join(engine.dataDir, "engine", "actions.jsonl"))).toBe(false);
	await engine.shutdown();
}, T);

test("an action can run while a reply streams; two actions can run at once", async () => {
	const engine = start();
	await engine.configure({ faux: { tokensPerSecond: 200, replies: [{ text: "long reply ".repeat(10) }, { text: "A" }, { text: "B" }] } });
	const from = engine.records.length;
	engine.send({ type: "prompt", id: "p-main", text: "talk" });
	await engine.waitFor((r) => r.type === "text_delta" && r.id === "p-main", from);
	engine.send({ type: "run_action", id: "action-14", action: spec(), selection: "x" });
	engine.send({ type: "run_action", id: "action-15", action: spec(), selection: "y" });
	const ends = await Promise.all(
		["action-14", "action-15"].map((id) => engine.waitFor<ActionEnd>((r) => r.type === "action_end" && r.id === id, from)),
	);
	expect(ends.every((e) => !e.aborted && e.text.length > 0)).toBe(true);
	expect((await engine.waitFor((r) => r.type === "reply_end" && r.id === "p-main", from)) as { aborted: boolean }).toMatchObject({ aborted: false });
	await engine.shutdown();
}, T);

test("an agent action is a normal prompt in the thread with the selection", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [{ text: "done" }] } });
	const from = engine.records.length;
	const result = await callAs(engine, "action-16", { type: "run_action", action: spec({ output: "agent", prompt: "Summarise this" }), selection: "long text" });
	expect(result).toMatchObject({ ok: true, data: { steered: false } });
	const end = await engine.waitFor((r) => r.type === "reply_end" && r.id === "action-16", from);
	expect(end).toMatchObject({ text: "done", aborted: false });
	const records = engine.records.slice(from).filter((r) => "id" in r && r.id === "action-16").map((r) => r.type);
	expect(records).toContain("thinking");
	expect(records).toContain("text_delta");
	expect(records).not.toContain("action_end");
	const transcript = await engine.callOk<TranscriptItem[]>({ type: "transcript" });
	expect(transcript[0]).toMatchObject({ kind: "user", text: 'Summarise this\n\nSelected text:\n"""\nlong text\n"""' });
	expect(transcript[1]).toMatchObject({ kind: "assistant", text: "done" });
	expect(existsSync(join(engine.dataDir, "engine", "actions.jsonl"))).toBe(false);
	await engine.shutdown();
}, T);

test("run_action before configure fails with a config error and an aborted action_end", async () => {
	const engine = start();
	const result = await callAs(engine, "action-17", { type: "run_action", action: spec(), selection: "x" });
	expect(result).toMatchObject({ ok: false, errorKind: "config" });
	expect(engine.records.find((r) => r.type === "action_end")).toMatchObject({ id: "action-17", aborted: true });
	await engine.shutdown();
}, T);
