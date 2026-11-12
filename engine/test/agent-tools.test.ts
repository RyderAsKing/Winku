// The agent tools through the real engine process: cwd is the fake home, Requests are answered
// by the harness (the shell's part). No network: web tools are covered in tools.test.ts.
import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { FauxStep } from "../src/faux.ts";
import type { OutboundMessage, Request, TranscriptItem } from "../src/protocol.ts";
import { DECLINED } from "../src/tools/permission.ts";
import { EngineProcess, removeTempDirs } from "./harness.ts";

const running: EngineProcess[] = [];
function start(): EngineProcess {
	const engine = EngineProcess.start();
	running.push(engine);
	return engine;
}
afterAll(removeTempDirs);
afterEach(() => {
	for (const engine of running.splice(0)) {
		try {
			engine.proc.kill();
		} catch {}
	}
});

const T = 30_000;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const call = (name: string, args: Record<string, unknown> = {}): FauxStep => ({ toolCalls: [{ name, arguments: args }] });

type ToolRow = Extract<TranscriptItem, { kind: "tool" }>;
async function toolRows(engine: EngineProcess): Promise<ToolRow[]> {
	const transcript = await engine.callOk<TranscriptItem[]>({ type: "transcript" });
	return transcript.filter((t): t is ToolRow => t.kind === "tool");
}
const permissionRequests = (records: OutboundMessage[]) =>
	records.filter((r): r is Extract<Request, { method: "permission" }> => r.type === "request" && r.method === "permission");

// pi's grep runs ripgrep; the engine offers grep only when rg is on PATH.
const ripgrep = !!Bun.which("rg");

test("file tools run in the home folder and read well in tool events", async () => {
	const engine = start();
	const steps: FauxStep[] = [
		call("write", { path: "notes.txt", content: "hello world\n" }),
		call("read", { path: "notes.txt" }),
		call("edit", { path: "notes.txt", edits: [{ oldText: "world", newText: "there" }] }),
		call("ls", {}),
		call("find", { pattern: "*.txt" }),
		...(ripgrep ? [call("grep", { pattern: "hello" })] : []),
		{ text: "Done." },
	];
	await engine.configure({ faux: { replies: steps } });
	const { end, records } = await engine.prompt("make a note");
	expect(end).toMatchObject({ text: "Done.", aborted: false });
	expect(readFileSync(join(engine.home, "notes.txt"), "utf8")).toBe("hello there\n");
	expect(existsSync(join(engine.dataDir, "notes.txt"))).toBe(false);

	const starts = records.filter((r) => r.type === "tool_start").map((r) => (r.type === "tool_start" ? [r.name, r.summary] : []));
	expect(starts).toEqual([
		["write", "notes.txt"],
		["read", "notes.txt"],
		["edit", "notes.txt"],
		["ls", "~"],
		["find", "*.txt"],
		...(ripgrep ? [["grep", "hello"]] : []),
	]);
	const ends = records.filter((r) => r.type === "tool_end").map((r) => (r.type === "tool_end" ? r.ok : null));
	expect(ends.every((ok) => ok === true)).toBe(true);
	expect(ends).toHaveLength(starts.length);
	const rows = await toolRows(engine);
	expect(rows.find((r) => r.name === "read")?.detail).toContain("hello world");
	expect(rows.find((r) => r.name === "ls")?.detail).toContain("notes.txt");
	expect(rows.find((r) => r.name === "find")?.detail).toContain("notes.txt");
	if (ripgrep) expect(rows.find((r) => r.name === "grep")?.detail).toContain("hello there");
	await engine.shutdown();
}, T);

test.skipIf(process.platform === "win32")("bash runs in the home folder", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [call("bash", { command: "pwd > where.txt" }), { text: "ok" }] } });
	const { records } = await engine.prompt("where am I?");
	expect(records.find((r) => r.type === "tool_start")).toMatchObject({ name: "bash", summary: "pwd > where.txt" });
	expect(records.find((r) => r.type === "tool_end")).toMatchObject({ ok: true });
	expect(readFileSync(join(engine.home, "where.txt"), "utf8").trim()).toBe(realpathSync(engine.home));
	await engine.shutdown();
}, T);

test("web_search is offered only with a search key; changing it keeps the thread", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [{ echoTools: true }, { echoTools: true }, { echoTools: true }] } });
	const first = (await engine.prompt("tools?")).end.text;
	const names = first.replace("tools: ", "").split(",");
	for (const name of ["read", "ls", "find", "write", "edit", "open", "web_fetch", "look_at_screen", "clipboard_read", "clipboard_write", "clipboard_edit", "memory_save", "memory_read", "voice_propose"])
		expect(names).toContain(name);
	if (process.platform === "win32") expect(names).toContain("powershell");
	else expect(names).toContain("bash");
	expect(names).not.toContain("web_search");

	await engine.configure({ faux: { replies: [{ echoTools: true }, { echoTools: true }, { echoTools: true }] }, searchApiKey: "sk-test" });
	expect((await engine.prompt("tools now?")).end.text).toContain("web_search");
	await engine.configure({ faux: { replies: [{ echoTools: true }, { echoTools: true }, { echoTools: true }] } });
	expect((await engine.prompt("and now?")).end.text).not.toContain("web_search");

	// Same thread throughout: the faux script carried on and no thread change was announced.
	expect(engine.records.some((r) => r.type === "thread_changed")).toBe(false);
	const transcript = await engine.callOk<TranscriptItem[]>({ type: "transcript" });
	expect(transcript.filter((t) => t.kind === "user")).toHaveLength(3);
	await engine.shutdown();
}, T);

test("changing tool settings mid-reply doesn't disturb the reply", async () => {
	const engine = start();
	const slow = { faux: { tokensPerSecond: 40, replies: [{ text: "one two three four five six seven eight nine ten eleven twelve" }] } };
	await engine.configure(slow);
	const id = "slow-1";
	const from = engine.records.length;
	engine.send({ type: "prompt", id, text: "count" });
	await engine.waitFor((r) => r.type === "text_delta" && r.id === id, from);
	await engine.configure({ ...slow, askBeforeRunning: true, alwaysAllow: ["bash:ls"], searchApiKey: "sk" });
	const end = await engine.waitFor((r) => r.type === "reply_end" && r.id === id, from);
	expect(end).toMatchObject({ aborted: false, text: "one two three four five six seven eight nine ten eleven twelve" });
	await engine.shutdown();
}, T);

test("look_at_screen asks the shell for a capture and returns text and image", async () => {
	const engine = start();
	engine.onRequest = (request) =>
		request.method === "screen_capture"
			? { ok: true, data: { app: "notepad.exe", windowTitle: "notes - Notepad", text: "Hello from the screen", image: { data: PNG, mimeType: "image/png" } } }
			: undefined;
	await engine.configure({ faux: { replies: [call("look_at_screen"), { echoImages: true }] } });
	const { end, records } = await engine.prompt("what's on my screen?");
	const request = engine.records.find((r) => r.type === "request");
	expect(request).toMatchObject({ method: "screen_capture", params: { includeImage: true } });
	expect(records.find((r) => r.type === "tool_start")).toMatchObject({ name: "look_at_screen", summary: "the active window" });
	expect(records.find((r) => r.type === "tool_end")).toMatchObject({ ok: true });
	// The screenshot reached the model as an image.
	expect(end.text).toBe("images:1 removed:0");
	const row = (await toolRows(engine))[0];
	expect(row?.detail).toContain("App: notepad.exe");
	expect(row?.detail).toContain("Window: notes - Notepad");
	expect(row?.detail).toContain("Hello from the screen");
	await engine.shutdown();
}, T);

test("look_at_screen without image support asks for text only; a shell error fails the tool", async () => {
	const engine = start();
	let answer: { ok: boolean; data?: unknown; error?: string } = {
		ok: true,
		data: { app: "excel.exe", text: "Q3 totals", image: { data: PNG, mimeType: "image/png" } },
	};
	engine.onRequest = (request) => (request.method === "screen_capture" ? answer : undefined);
	await engine.configure({
		faux: { supportsImages: false, replies: [call("look_at_screen"), { echoImages: true }, call("look_at_screen"), { text: "sorry" }] },
	});
	const { end } = await engine.prompt("look");
	expect(engine.records.find((r) => r.type === "request")).toMatchObject({ params: { includeImage: false } });
	expect(end.text).toBe("images:0 removed:0");
	const row = (await toolRows(engine))[0];
	expect(row?.detail).toContain("Q3 totals");
	expect(row?.detail).toContain("can't see images");

	answer = { ok: false, error: "No window to capture" };
	const second = await engine.prompt("look again");
	expect(second.records.find((r) => r.type === "tool_end")).toMatchObject({ ok: false });
	expect((await toolRows(engine))[1]?.detail).toContain("No window to capture");
	await engine.shutdown();
}, T);

test("ask before running: allow once asks again, always stops asking, deny doesn't run", async () => {
	const engine = start();
	const decisions = ["allow_once", "always", "deny"];
	engine.onRequest = (request) => (request.method === "permission" ? { ok: true, data: { decision: decisions.shift() } } : undefined);
	await engine.configure({
		askBeforeRunning: true,
		faux: {
			replies: [
				call("write", { path: "a.txt", content: "1" }),
				call("write", { path: "a.txt", content: "2" }),
				call("write", { path: "a.txt", content: "3" }),
				call("write", { path: "b.txt", content: "nope" }),
				call("read", { path: "a.txt" }),
				{ text: "done" },
			],
		},
	});
	const { end, records } = await engine.prompt("write things");
	expect(end).toMatchObject({ text: "done", aborted: false });
	const asked = permissionRequests(engine.records).map((r) => r.params);
	const a = join(engine.home, "a.txt");
	const b = join(engine.home, "b.txt");
	expect(asked).toEqual([
		{ replyId: end.id, tool: "write", summary: `Write ${a}`, allowKey: `write:${a}` },
		{ replyId: end.id, tool: "write", summary: `Write ${a}`, allowKey: `write:${a}` },
		{ replyId: end.id, tool: "write", summary: `Write ${b}`, allowKey: `write:${b}` },
	]);
	expect(readFileSync(a, "utf8")).toBe("3");
	expect(existsSync(b)).toBe(false);
	const ends = records.filter((r) => r.type === "tool_end").map((r) => (r.type === "tool_end" ? r.ok : null));
	expect(ends).toEqual([true, true, true, false, true]);
	expect((await toolRows(engine))[3]?.detail).toContain(DECLINED);
	await engine.shutdown();
}, T);

test("ask before running: off never asks; alwaysAllow from configure skips the request", async () => {
	const engine = start();
	engine.onRequest = (request) => (request.method === "permission" ? { ok: true, data: { decision: "deny" } } : undefined);
	await engine.configure({ faux: { replies: [call("write", { path: "off.txt", content: "x" }), { text: "ok" }] } });
	await engine.prompt("write");
	expect(permissionRequests(engine.records)).toHaveLength(0);
	expect(existsSync(join(engine.home, "off.txt"))).toBe(true);

	const key = `WRITE:${join(engine.home, "allowed.txt")}`;
	await engine.configure({
		askBeforeRunning: true,
		alwaysAllow: [key],
		faux: { replies: [call("write", { path: "allowed.txt", content: "x" }), call("write", { path: "other.txt", content: "x" }), { text: "ok" }] },
	});
	await engine.prompt("write two");
	expect(existsSync(join(engine.home, "allowed.txt"))).toBe(true);
	// Only the file that isn't always-allowed was asked about (and denied).
	expect(permissionRequests(engine.records).map((r) => r.params.allowKey)).toEqual([`write:${join(engine.home, "other.txt")}`]);
	expect(existsSync(join(engine.home, "other.txt"))).toBe(false);
	await engine.shutdown();
}, T);

test("abort while a permission request is open denies the call", async () => {
	const engine = start();
	engine.onRequest = () => undefined; // the user never answers
	await engine.configure({ askBeforeRunning: true, faux: { replies: [call("write", { path: "late.txt", content: "x" }), { text: "never" }] } });
	const id = "p-abort";
	const from = engine.records.length;
	engine.send({ type: "prompt", id, text: "write" });
	const request = await engine.waitFor((r) => r.type === "request", from);
	expect(request).toMatchObject({ method: "permission", params: { replyId: id, tool: "write" } });
	engine.send({ type: "abort" });
	const end = await engine.waitFor((r) => r.type === "reply_end" && r.id === id, from);
	expect(end).toMatchObject({ aborted: true });
	expect(engine.records.slice(from).find((r) => r.type === "tool_end")).toMatchObject({ ok: false });
	// A late answer is ignored and nothing is written.
	engine.send({ type: "response", id: (request as Request).id, ok: true, data: { decision: "allow_once" } });
	await engine.callOk({ type: "stats" });
	expect(existsSync(join(engine.home, "late.txt"))).toBe(false);
	await engine.shutdown();
}, T);

test("compaction replaces screenshots in the kept messages with a note", async () => {
	const engine = start();
	const long = "lorem ipsum dolor sit amet ".repeat(120); // ~800 tokens; an image counts as 1200
	// Every model call (the compaction summary too) answers with the images it was sent.
	await engine.configure({
		compactionReserveTokens: 1000,
		faux: { contextWindow: 6000, keepRecentTokens: 3000, tokensPerSecond: 1_000_000, replies: Array(20).fill({ echoImages: true }) },
	});
	await engine.prompt(`zero ${long}`);
	const before = await engine.prompt("what is this?", { images: [{ data: PNG, mimeType: "image/png" }] });
	expect(before.end.text).toBe("images:1 removed:0");
	// Add text until pi compacts (once a run ends over the threshold), keeping the most recent turns, image included.
	for (let i = 0; i < 6 && !engine.records.some((r) => r.type === "compaction_end"); i++) await engine.prompt(`more ${long}`);
	await engine.waitFor((r) => r.type === "compaction_end");
	expect(engine.records.find((r) => r.type === "compaction_end")).toMatchObject({ ok: true });
	const after = await engine.prompt("and now?");
	expect(after.end.text).toBe("images:0 removed:1");
	// A screenshot sent after the compaction stays.
	const later = await engine.prompt("this one?", { images: [{ data: PNG, mimeType: "image/png" }] });
	expect(later.end.text).toBe("images:1 removed:1");
	// The transcript still counts the original screenshot.
	const transcript = await engine.callOk<TranscriptItem[]>({ type: "transcript" });
	const images = transcript.filter((t) => t.kind === "user").map((t) => (t.kind === "user" ? t.images : 0));
	expect(images[1]).toBe(1);
	expect(images.at(-1)).toBe(1);
	await engine.shutdown();
}, T);

// ───────────────────────────── clipboard ─────────────────────────────

test("clipboard_read returns text, an image, file paths, or says it is empty or private", async () => {
	const engine = start();
	const answers: unknown[] = [
		{ kind: "text", text: "copied words" },
		{ kind: "image", image: { data: PNG, mimeType: "image/png" } },
		{ kind: "files", paths: ["C:\\Users\\me\\a.txt", "C:\\Users\\me\\b.pdf"] },
		{ kind: "empty" },
		{ kind: "private" },
	];
	engine.onRequest = (request) => (request.method === "clipboard_read" ? { ok: true, data: answers.shift() } : undefined);
	await engine.configure({
		faux: { replies: [call("clipboard_read"), call("clipboard_read"), { echoImages: true }, call("clipboard_read"), call("clipboard_read"), call("clipboard_read"), { text: "ok" }] },
	});
	const { end, records } = await engine.prompt("what did I copy?");
	expect(end.text).toBe("images:1 removed:0");
	expect(engine.records.find((r) => r.type === "request")).toMatchObject({ method: "clipboard_read", params: { includeImage: true } });
	expect(records.find((r) => r.type === "tool_start")).toMatchObject({ name: "clipboard_read", summary: "the clipboard" });
	await engine.prompt("and the rest?");
	const rows = await toolRows(engine);
	expect(rows[0]?.detail).toContain("copied words");
	expect(rows[1]?.detail).toContain("image");
	expect(rows[2]?.detail).toContain("C:\\Users\\me\\a.txt\nC:\\Users\\me\\b.pdf");
	expect(rows[3]?.detail).toContain("The clipboard is empty.");
	expect(rows[4]?.detail).toContain("marked private");
	expect(rows[4]?.detail).not.toContain("copied");
	await engine.shutdown();
}, T);

test("clipboard_read without image support asks for no image; a shell error (not Windows) fails the tool", async () => {
	const engine = start();
	let answer: { ok: boolean; data?: unknown; error?: string } = { ok: true, data: { kind: "image", image: { data: PNG, mimeType: "image/png" } } };
	engine.onRequest = (request) => (request.method === "clipboard_read" ? answer : undefined);
	await engine.configure({ faux: { supportsImages: false, replies: [call("clipboard_read"), { echoImages: true }, call("clipboard_read"), { text: "sorry" }] } });
	const { end } = await engine.prompt("look");
	expect(engine.records.find((r) => r.type === "request")).toMatchObject({ params: { includeImage: false } });
	expect(end.text).toBe("images:0 removed:0");
	expect((await toolRows(engine))[0]?.detail).toContain("can't see images");
	answer = { ok: false, error: "The clipboard isn't available on this system." };
	const second = await engine.prompt("again");
	expect(second.records.find((r) => r.type === "tool_end")).toMatchObject({ ok: false });
	expect((await toolRows(engine))[1]?.detail).toContain("isn't available");
	await engine.shutdown();
}, T);

test("clipboard_read reads an earlier copy by index, and lists the history as index, age and preview", async () => {
	const engine = start();
	const history = ["the newest copy", "an earlier copy", "the oldest copy"];
	engine.onRequest = (request) => {
		if (request.method !== "clipboard_read") return undefined;
		const { index, list } = request.params as { index?: number; list?: boolean };
		if (list)
			return {
				ok: true,
				data: {
					entries: [
						{ index: 0, ageSeconds: 5, chars: 15, preview: "the newest copy" },
						{ index: 1, ageSeconds: 200, chars: 15, preview: "an earlier copy" },
						{ index: 2, ageSeconds: 7300, chars: 15, preview: "the oldest copy" },
					],
				},
			};
		if (index !== undefined) {
			const text = history[index];
			return text ? { ok: true, data: { kind: "text", text } } : { ok: false, error: `There is no copy ${index}; the history holds 3.` };
		}
		return { ok: true, data: { kind: "text", text: history[0] } };
	};
	await engine.configure({
		faux: { replies: [call("clipboard_read", { list: true }), call("clipboard_read", { index: 1 }), call("clipboard_read", { index: 9 }), { text: "found it" }] },
	});
	const { records } = await engine.prompt("what did I copy before this?");
	const requests: unknown[] = engine.records.filter((r) => r.type === "request").map((r) => (r.type === "request" ? r.params : null));
	expect(requests).toEqual([
		{ includeImage: false, list: true },
		{ includeImage: false, index: 1 },
		{ includeImage: false, index: 9 },
	]);
	expect(records.filter((r) => r.type === "tool_start").map((r) => (r.type === "tool_start" ? r.summary : ""))).toEqual([
		"the clipboard history",
		"copy 1 from the clipboard history",
		"copy 9 from the clipboard history",
	]);
	const rows = await toolRows(engine);
	expect(rows[0]?.detail).toContain("0: 5 s ago, 15 characters: the newest copy");
	expect(rows[0]?.detail).toContain("1: 3 min ago, 15 characters: an earlier copy");
	expect(rows[0]?.detail).toContain("2: 2 h ago, 15 characters: the oldest copy");
	expect(rows[1]?.detail).toContain("Copy 1 from the clipboard history:\nan earlier copy");
	expect(rows[2]?.detail).toContain("There is no copy 9");
	expect(records.filter((r) => r.type === "tool_end").map((r) => (r.type === "tool_end" ? r.ok : null))).toEqual([true, true, false]);
	await engine.shutdown();
}, T);

test("an empty clipboard history says so", async () => {
	const engine = start();
	engine.onRequest = (request) => (request.method === "clipboard_read" ? { ok: true, data: { entries: [] } } : undefined);
	await engine.configure({ faux: { replies: [call("clipboard_read", { list: true }), { text: "none" }] } });
	await engine.prompt("list my copies");
	expect((await toolRows(engine))[0]?.detail).toContain("The clipboard history is empty");
	await engine.shutdown();
}, T);

/** A fake shell clipboard: answers clipboard_read and clipboard_write. */
function fakeClipboard(engine: EngineProcess, initial: string, decision?: () => string) {
	const state = { text: initial, writes: 0 };
	engine.onRequest = (request) => {
		if (request.method === "clipboard_read") return { ok: true, data: { kind: "text", text: state.text } };
		if (request.method === "clipboard_write") {
			state.text = request.params.text;
			state.writes++;
			return { ok: true };
		}
		if (request.method === "permission" && decision) return { ok: true, data: { decision: decision() } };
		return undefined;
	};
	return state;
}

test("clipboard_write puts the text on the clipboard", async () => {
	const engine = start();
	const clip = fakeClipboard(engine, "old");
	await engine.configure({ faux: { replies: [call("clipboard_write", { text: "fresh answer" }), { text: "copied" }] } });
	const { records } = await engine.prompt("copy that");
	expect(clip.text).toBe("fresh answer");
	expect(records.find((r) => r.type === "tool_end")).toMatchObject({ ok: true });
	await engine.shutdown();
}, T);

test("clipboard_edit changes only the named part; zero or several matches fail and change nothing", async () => {
	const engine = start();
	const clip = fakeClipboard(engine, "Dear Bob, see you at 12. Bye");
	await engine.configure({
		faux: {
			replies: [
				call("clipboard_edit", { oldText: "at 12", newText: "at 1" }),
				call("clipboard_edit", { oldText: "Alice", newText: "Carol" }),
				call("clipboard_edit", { oldText: "e", newText: "E" }),
				{ text: "done" },
			],
		},
	});
	const { records } = await engine.prompt("fix the time");
	expect(clip.text).toBe("Dear Bob, see you at 1. Bye");
	expect(clip.writes).toBe(1);
	const ends = records.filter((r) => r.type === "tool_end").map((r) => (r.type === "tool_end" ? r.ok : null));
	expect(ends).toEqual([true, false, false]);
	const rows = await toolRows(engine);
	expect(rows[1]?.detail).toContain("not found");
	expect(rows[2]?.detail).toContain("more than once");
	await engine.shutdown();
}, T);

test("ask before running: clipboard write and edit ask first, read does not", async () => {
	const engine = start();
	const clip = fakeClipboard(engine, "abc", () => "deny");
	await engine.configure({
		askBeforeRunning: true,
		faux: {
			replies: [
				call("clipboard_read"),
				call("clipboard_write", { text: "xyz" }),
				call("clipboard_edit", { oldText: "b", newText: "B" }),
				{ text: "done" },
			],
		},
	});
	await engine.prompt("go");
	expect(permissionRequests(engine.records).map((r) => r.params.tool)).toEqual(["clipboard_write", "clipboard_edit"]);
	expect(clip.text).toBe("abc");
	expect(clip.writes).toBe(0);
	await engine.shutdown();
}, T);
