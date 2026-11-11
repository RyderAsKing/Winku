import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryEntry, ModelInfo, OutboundMessage, ProviderInfo, TranscriptItem } from "../src/protocol.ts";
import { deltas, EngineProcess } from "./harness.ts";

const running: EngineProcess[] = [];
function start(): EngineProcess {
	const engine = EngineProcess.start();
	running.push(engine);
	return engine;
}
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
		{ type: "result", id: end.id, ok: true, data: { queued: false } },
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

test("reports tool calls generically", async () => {
	const engine = start();
	await engine.configure({
		faux: { replies: [{ text: "Let me look.", toolCalls: [{ name: "look_at_screen", arguments: { why: "check" } }] }, { text: "Done. <mood:neutral>" }] },
	});
	const { end, records } = await engine.prompt("look");
	const toolStart = records.find((r) => r.type === "tool_start");
	const toolEnd = records.find((r) => r.type === "tool_end");
	expect(toolStart).toMatchObject({ name: "look_at_screen", summary: "look_at_screen: check" });
	// No tools are registered in step 2, so the call fails.
	expect(toolEnd).toMatchObject({ ok: false, summary: "look_at_screen: check" });
	expect(end).toMatchObject({ text: "Let me look.\n\nDone.", mood: "neutral" });
	expect(deltas(records)).toBe(end.text);
	const transcript = await engine.callOk<TranscriptItem[]>({ type: "transcript" });
	expect(transcript.map((t) => t.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
	expect(transcript[2]).toMatchObject({ name: "look_at_screen", ok: false });
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

test("a prompt while streaming is queued as a follow-up", async () => {
	const engine = start();
	await engine.configure({ faux: { tokensPerSecond: 200, replies: [{ text: "first reply ".repeat(10) }, { text: "second reply" }] } });
	const from = engine.records.length;
	engine.send({ type: "prompt", id: "a", text: "one" });
	await engine.waitFor((r) => r.type === "text_delta" && r.id === "a", from);
	engine.send({ type: "prompt", id: "b", text: "two" });
	const resultB = await engine.waitFor((r) => r.type === "result" && r.id === "b", from);
	expect(resultB).toMatchObject({ ok: true, data: { queued: true } });
	const endB = await engine.waitFor((r) => r.type === "reply_end" && r.id === "b", from);
	const endA = engine.records.find((r) => r.type === "reply_end" && r.id === "a");
	expect(endA).toMatchObject({ text: "first reply ".repeat(10).trimEnd(), aborted: false });
	expect(endB).toMatchObject({ text: "second reply", aborted: false });
	expect(engine.records.indexOf(endA as OutboundMessage)).toBeLessThan(engine.records.indexOf(endB));
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
	expect(await engine.call({ type: "run_action", action: { name: "x", prompt: "y", output: "show", useThreadContext: false, useVoice: false }, selection: "s" })).toMatchObject({
		ok: false,
		error: "Not available until step 4",
	});
	expect(await engine.call({ type: "memory_undo", saveId: "s" })).toMatchObject({ ok: false, error: "Not available until step 5" });
	expect(await engine.call({ type: "memory_forget_all" })).toMatchObject({ ok: false, error: "Not available until step 5" });
	expect(await engine.call({ type: "voice_proposal_decision", proposalId: "p", accept: true })).toMatchObject({
		ok: false,
		error: "Not available until step 5",
	});
	const stats = await engine.callOk<{ rssBytes: number; heapUsedBytes: number; uptimeMs: number }>({ type: "stats" });
	expect(stats.rssBytes).toBeGreaterThan(0);
	expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);
	expect(await engine.call({ type: "abort" })).toMatchObject({ ok: true });
	const results = engine.records.filter((r) => r.type === "result");
	expect(new Set(results.map((r) => (r.type === "result" ? r.id : ""))).size).toBe(results.length);
	const { exitCode } = await engine.shutdown();
	expect(exitCode).toBe(0);
}, T);
