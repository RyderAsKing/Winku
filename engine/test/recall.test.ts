import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	coreFile,
	coreForPrompt,
	coreLines,
	editCoreLines,
	ensureStarterFiles,
	MemoryStore,
	parseNotes,
	removeNote,
} from "../src/memory.ts";
import type { MemoryOverview, OutboundMessage, Request, TranscriptItem } from "../src/protocol.ts";
import { type Embed, fit, formatRecalled, keywords, RecallIndex, recalledIds, stripRecalled } from "../src/recall.ts";
import { applyOps, conversationText, parsePlan } from "../src/tidy.ts";
import { EngineProcess, removeTempDirs, tempDir } from "./harness.ts";

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
const read = (path: string) => readFileSync(path, "utf8");

/** A stand-in for bge-small: hashed bag of keywords, L2-normalised. Shared words make texts similar. */
function fakeVector(text: string): Float32Array {
	const v = new Float32Array(384);
	for (const word of keywords(text)) {
		let h = 0;
		for (const c of word) h = (h * 31 + c.charCodeAt(0)) >>> 0;
		v[h % 384] = (v[h % 384] as number) + 1;
	}
	const norm = Math.hypot(...v) || 1;
	return v.map((x) => x / norm);
}
const fakeEmbed: Embed = async (texts) => texts.map(fakeVector);

function encode(v: Float32Array): string {
	return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
}

/** Answer the engine's embed Requests like the shell would, with the fake vectors. */
function shellEmbedder(engine: EngineProcess, seen: string[][] = []): string[][] {
	engine.onRequest = (request: Request) => {
		if (request.method !== "embed") return undefined;
		seen.push(request.params.texts);
		return { ok: true, data: { model: "bge-small-en-v1.5", dims: 384, vectors: request.params.texts.map((t) => encode(fakeVector(t))) } };
	};
	return seen;
}

function memoryDir(): { dir: string; store: MemoryStore } {
	const dir = tempDir("winku-recall-");
	ensureStarterFiles(dir);
	return { dir, store: new MemoryStore(dir, () => new Date("2026-11-11T10:00:00Z")) };
}

// ───────────────────────────── notes and core files ─────────────────────────────

test("topic files split into notes; ids are stable; one note can be removed", () => {
	const text = "# food\n\nloose line\n\n## 2026-10-02: Oat milk <!-- important -->\n\nPrefers oat milk.\n\n## No date\n\nLikes rye bread.\n";
	const notes = parseNotes("food", text, 5);
	expect(notes.map((n) => [n.title, n.body, n.important])).toEqual([
		["food", "loose line", false],
		["Oat milk", "Prefers oat milk.", true],
		["No date", "Likes rye bread.", false],
	]);
	expect(notes[1]?.date).toBe(Date.parse("2026-10-02T12:00:00Z"));
	expect(notes[2]?.date).toBe(5);
	expect(parseNotes("food", text, 9).map((n) => n.id)).toEqual(notes.map((n) => n.id));
	expect(removeNote("food", text, notes[1]?.id as string)).toBe("# food\n\nloose line\n\n## No date\n\nLikes rye bread.\n");
	expect(removeNote("food", text, notes[0]?.id as string)).toBe("# food\n\n## 2026-10-02: Oat milk <!-- important -->\n\nPrefers oat milk.\n\n## No date\n\nLikes rye bread.\n");
	expect(removeNote("food", text, "nope")).toBeUndefined();
});

test("core lines: add, replace by quoted text, drop, no duplicates; the prompt keeps whole lines within budget", () => {
	expect(coreLines("# Profile\n\n- Lives in Berlin\n* Has a cat\nfree text\n<!-- hidden -->\n")).toEqual(["Lives in Berlin", "Has a cat", "free text"]);
	let lines = ["Lives in Delhi", "Has a cat"];
	expect(editCoreLines(lines, "Lives in Berlin", "- lives in delhi.")).toEqual({ lines: ["Lives in Berlin", "Has a cat"], added: "Lives in Berlin", removed: "Lives in Delhi" });
	expect(editCoreLines(lines, "", "Has a cat")).toEqual({ lines: ["Lives in Delhi"], removed: "Has a cat" });
	expect(editCoreLines(lines, "has a cat", undefined)).toEqual({ lines });
	expect(() => editCoreLines(lines, "", "Has a dog")).toThrow("No line");
	lines = Array.from({ length: 200 }, (_, i) => `Fact number ${i} about the user`);
	const prompt = coreForPrompt("profile", coreFile("profile", lines));
	expect(prompt.length).toBeLessThanOrEqual(2400);
	expect(prompt.startsWith("- Fact number 0 about the user\n")).toBe(true);
	expect(prompt.endsWith("about the user")).toBe(true);
});

test("old topics named profile, goals or recap are moved aside, index line and all", () => {
	const dir = tempDir("winku-migrate-");
	ensureStarterFiles(dir);
	writeFileSync(join(dir, "memory", "goals.md"), "# goals\n\n## 2026-01-01: Run\n\nA marathon.\n");
	writeFileSync(join(dir, "memory", "MEMORY.md"), "- [Run](goals.md): A marathon.\n");
	ensureStarterFiles(dir);
	expect(existsSync(join(dir, "memory", "goals-notes.md"))).toBe(true);
	expect(read(join(dir, "memory", "MEMORY.md"))).toBe("- [Run](goals-notes.md): A marathon.\n");
	expect(new MemoryStore(dir).topics()).toEqual(["goals-notes"]);
});

test("profile saves undo exactly, or just their own line once the file changed", () => {
	const { dir, store } = memoryDir();
	const a = store.saveCore("profile", { title: "Lives in Delhi", content: "Lives in Delhi" }, "s1");
	expect(read(join(dir, "memory", "PROFILE.md"))).toBe("# Profile\n\n- Lives in Delhi\n");
	const b = store.saveCore("profile", { title: "Moved", content: "Lives in Berlin", replaces: "Lives in Delhi" }, "s1");
	store.saveCore("goals", { title: "Ship", content: "Ship 0.2 by Friday" }, "s1");
	writeFileSync(join(dir, "memory", "PROFILE.md"), "# Profile\n\n- Lives in Berlin\n- Added by hand\n");
	store.undo(b.saveId, "s1");
	expect(read(join(dir, "memory", "PROFILE.md"))).toBe("# Profile\n\n- Lives in Delhi\n- Added by hand\n");
	store.undo(a.saveId, "s1");
	expect(read(join(dir, "memory", "PROFILE.md"))).toBe("# Profile\n\n- Added by hand\n");
	expect(read(join(dir, "memory", "GOALS.md"))).toBe("# Goals\n\n- Ship 0.2 by Friday\n");
	expect(store.topics()).toEqual([]);
});

// ───────────────────────────── recall ─────────────────────────────

test("recall finds related notes by meaning and keyword, skips unrelated and excluded ones, and follows edits", async () => {
	const { dir, store } = memoryDir();
	store.save({ title: "Oat milk", topic: "food", content: "Prefers oat milk in coffee, no sugar." }, "s");
	store.save({ title: "Dog", topic: "pets", content: "Has a dog named Biscuit who needs a walk at 6pm." }, "s");
	store.save({ title: "Release", topic: "work", content: "Winku 0.2 release is planned for Friday." }, "s");
	const index = new RecallIndex(store, RecallIndex.pathFor(dir), fakeEmbed, () => Date.parse("2026-11-12T00:00:00Z"));
	// First search embeds in the background; the next one compares vectors.
	await index.search("coffee");
	await index.settled();
	expect(index.stats()).toEqual({ notes: 3, embedded: 3 });
	const hits = await index.search("what milk goes in my coffee?");
	expect(hits.map((h) => h.title)).toEqual(["Oat milk"]);
	expect(hits[0]?.similarity).toBeGreaterThan(0.5);
	expect(await index.search("hello there")).toEqual([]);
	expect(await index.search("what milk goes in my coffee?", { exclude: new Set([hits[0]?.id as string]) })).toEqual([]);
	// Edit the file by hand: the index follows.
	writeFileSync(join(dir, "memory", "food.md"), "# food\n\n## 2026-11-11: Milk\n\nSwitched to almond milk in coffee.\n");
	const after = await index.search("what milk goes in my coffee?");
	expect(after.map((h) => h.body)).toEqual(["Switched to almond milk in coffee."]);
	index.reset();
	expect(existsSync(RecallIndex.pathFor(dir))).toBe(false);
});

test("without an embedder recall uses keywords, asking for more than one stray word", async () => {
	const { dir, store } = memoryDir();
	store.save({ title: "Dog", topic: "pets", content: "Has a dog named Biscuit who needs a walk at 6pm." }, "s");
	const index = new RecallIndex(store, RecallIndex.pathFor(dir), undefined);
	expect((await index.search("when does Biscuit need a walk?")).map((h) => h.title)).toEqual(["Dog"]);
	expect(await index.search("let's go for a walk in the park today")).toEqual([]);
	expect((await index.search("biscuit")).map((h) => h.title)).toEqual(["Dog"]);
});

test("recalled notes fit the budget and round-trip through the message", () => {
	const note = (id: string, body: string) => ({ id, topic: "t", title: id, date: 0, important: false, body });
	expect(fit([note("a", "x".repeat(5000)), note("b", "y"), note("c", "z"), note("d", "w"), note("e", "v")]).map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
	expect(fit([note("a", "x".repeat(5000))])[0]?.body.length).toBe(700);
	const block = formatRecalled([{ id: "abc123", topic: 'a"b', title: "T", date: 0, body: "B" }]);
	expect(block).toBe('\n\n<recalled_memories>\n<note id="abc123" topic="a&quot;b" date="1970-01-01">\nT\nB\n</note>\n</recalled_memories>');
	expect(stripRecalled(`hello${block}`)).toBe("hello");
	expect(recalledIds(`hello${block}`)).toEqual(["abc123"]);
	expect(formatRecalled([])).toBe("");
});

// ───────────────────────────── tidy (pure) ─────────────────────────────

test("tidy plans parse leniently and apply by text", () => {
	const plan = parsePlan(
		'Sure: {"profile":[{"op":"add","text":"Lives in Berlin"},{"op":"replace","line":1,"text":"Has two cats"},{"op":"remove","line":9},{"op":"bogus"}],"goals":[{"op":"remove","line":1}],"notes":[{"topic":"work","title":"Atlas","content":"Atlas ships in May."},{"topic":"","title":"x","content":"y"}],"recap":{"title":"Release","summary":"Planned the release."}}',
	);
	expect(plan.profile).toHaveLength(3);
	expect(plan.notes).toEqual([{ topic: "work", title: "Atlas", content: "Atlas ships in May." }]);
	expect(plan.recap).toEqual({ title: "Release", summary: "Planned the release." });
	expect(parsePlan('{"recap":null}')).toEqual({ profile: [], goals: [], notes: [], recap: null });
	expect(() => parsePlan("no json")).toThrow();
	// A line saved while the model thought survives; ops follow the text they were shown.
	expect(applyOps(["Has a cat"], ["Saved meanwhile", "Has a cat"], plan.profile)).toEqual(["Saved meanwhile", "Has two cats", "Lives in Berlin"]);
});

test("the conversation for tidy drops recalled notes and now lines and keeps saves", () => {
	const entries = [
		{ id: "1", type: "message", message: { role: "user", content: 'one\n\n<recalled_memories>\n<note id="a" topic="t" date="2026-01-01">\nT\nB\n</note>\n</recalled_memories>\n\n<now app="x.exe"></now>' } },
		{ id: "2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Sure. <mood:happy>" }, { type: "toolCall", id: "c", name: "memory_save", arguments: { kind: "goal", title: "Ship", content: "Ship Friday" } }] } },
		{ id: "3", type: "message", message: { role: "user", content: "two" } },
	] as never;
	expect(conversationText(entries, undefined)).toEqual({ text: "User: one\n\nAssistant: Sure.\n\n[saved to memory as goal: Ship: Ship Friday]\n\nUser: two", lastId: "3", userChars: 6 });
	expect(conversationText(entries, "2")).toEqual({ text: "User: two", lastId: "3", userChars: 3 });
	expect(conversationText(entries, "3")).toEqual({ text: "", lastId: "3", userChars: 0 });
	expect(conversationText(entries, undefined, 10).text).toBe("(earlier part left out)\n…\nUser: two");
});

// ───────────────────────────── through the engine ─────────────────────────────

test("recalled notes ride at the end of the user message, once per context, and stay out of the transcript", async () => {
	const engine = start();
	const asked = shellEmbedder(engine);
	await engine.configure({ faux: { replies: [{ echoUser: true }, { echoUser: true }, { echoUser: true }] } });
	const store = new MemoryStore(engine.dataDir);
	store.save({ title: "Oat milk", topic: "food", content: "Prefers oat milk in coffee." }, "x");
	const first = (await engine.prompt("which milk for my coffee?", { now: { app: "x.exe" } })).end.text;
	expect(first).toMatch(/^which milk for my coffee\?\n\n<recalled_memories>\n<note id="[0-9a-f]{12}" topic="food" date="\d{4}-\d{2}-\d{2}">\nOat milk\nPrefers oat milk in coffee\.\n<\/note>\n<\/recalled_memories>\n\n<now app="x.exe"><\/now>\n\[images:0\]$/);
	const second = (await engine.prompt("and milk for coffee tomorrow?")).end.text;
	expect(second).not.toContain("<recalled_memories>");
	expect(asked.some((texts) => texts[0] === "which milk for my coffee?")).toBe(true);
	const transcript = await engine.callOk<TranscriptItem[]>({ type: "transcript" });
	expect(transcript.filter((t) => t.kind === "user").map((t) => t.kind === "user" && t.text)).toEqual(["which milk for my coffee?", "and milk for coffee tomorrow?"]);
	await engine.callOk({ type: "clear" });
	expect((await engine.prompt("milk for coffee?")).end.text).toContain("<recalled_memories>");
	expect((await engine.shutdown()).stderr).toBe("");
}, T);

test("recall can be switched off, and an unanswered embedder doesn't hold a message up", async () => {
	const engine = start();
	await engine.configure({ memoryRecall: false, faux: { replies: [{ echoUser: true }, { echoUser: true }] } });
	new MemoryStore(engine.dataDir).save({ title: "Oat milk", topic: "food", content: "Prefers oat milk in coffee." }, "x");
	expect((await engine.prompt("which milk for my coffee?")).end.text).not.toContain("recalled");
	await engine.configure({ faux: { replies: [{ echoUser: true }] } });
	// No onRequest: the embed Request is never answered; keywords still find the note.
	const started = performance.now();
	expect((await engine.prompt("oat milk coffee")).end.text).toContain("<recalled_memories>");
	expect(performance.now() - started).toBeLessThan(2000);
	await engine.shutdown();
}, T);

test("memory_save kinds: profile and goal lines, replaces, and memory_search", async () => {
	const engine = start();
	shellEmbedder(engine);
	await engine.configure({
		faux: {
			replies: [
				{ toolCalls: [{ name: "memory_save", arguments: { kind: "profile", title: "Delhi", content: "Lives in Delhi" } }] },
				{ toolCalls: [{ name: "memory_save", arguments: { kind: "profile", title: "Moved", content: "Lives in Berlin", replaces: "Lives in Delhi" } }] },
				{ toolCalls: [{ name: "memory_save", arguments: { kind: "goal", title: "Ship", content: "Ship 0.2 by Friday" } }] },
				{ toolCalls: [{ name: "memory_save", arguments: { title: "Atlas", topic: "work", content: "Project Atlas ships in May.", important: true } }] },
				{ toolCalls: [{ name: "memory_search", arguments: { query: "when does atlas ship" } }] },
				{ text: "ok" },
			],
		},
	});
	await engine.prompt("remember all that");
	expect(read(join(engine.dataDir, "memory", "PROFILE.md"))).toBe("# Profile\n\n- Lives in Berlin\n");
	expect(read(join(engine.dataDir, "memory", "GOALS.md"))).toBe("# Goals\n\n- Ship 0.2 by Friday\n");
	expect(read(join(engine.dataDir, "memory", "work.md"))).toContain("Atlas <!-- important -->");
	const transcript = await engine.callOk<TranscriptItem[]>({ type: "transcript" });
	expect(transcript.filter((t) => t.kind === "memory_saved")).toHaveLength(4);
	const search = transcript.find((t) => t.kind === "tool" && t.name === "memory_search");
	expect(search?.kind === "tool" && search.detail).toContain("Project Atlas ships in May.");
	await engine.shutdown();
}, T);

test("tidy on clear updates the profile, goals and recap, and the new empty thread gets them", async () => {
	const engine = start();
	const plan = {
		profile: [{ op: "add", text: "Lives in Berlin" }],
		goals: [{ op: "add", text: "Ship Winku 0.2 by Friday" }],
		notes: [{ topic: "work", title: "Release scope", content: "Memory is the main item in 0.2." }],
		recap: { title: "Planning 0.2", summary: "Planned the 0.2 release around memory." },
	};
	await engine.configure({
		memoryTidy: true,
		faux: { replies: [{ text: "Sounds good." }, { text: JSON.stringify(plan) }, { echoSystemPrompt: true }] },
	});
	await engine.prompt("I moved to Berlin last month, and I want to ship Winku 0.2 with memory by Friday.");
	const from = engine.records.length;
	await engine.callOk({ type: "clear" });
	expect(await engine.waitFor((r) => r.type === "memory_tidy" && r.state !== "running", from)).toMatchObject({ state: "done", changed: true });
	const m = join(engine.dataDir, "memory");
	expect(read(join(m, "PROFILE.md"))).toBe("# Profile\n\n- Lives in Berlin\n");
	expect(read(join(m, "GOALS.md"))).toBe("# Goals\n\n- Ship Winku 0.2 by Friday\n");
	expect(read(join(m, "RECAP.md"))).toBe("# Recap\n\nPlanned the 0.2 release around memory.\n");
	expect(read(join(m, "threads.md"))).toContain("Planning 0.2");
	expect(read(join(m, "work.md"))).toContain("Memory is the main item in 0.2.");
	const prompt = (await engine.prompt("hi")).end.text;
	expect(prompt).toContain("<profile>\n- Lives in Berlin\n</profile>\n<goals>\n- Ship Winku 0.2 by Friday\n</goals>\n<recap>\nPlanned the 0.2 release around memory.\n</recap>");
	const overview = await engine.callOk<MemoryOverview>({ type: "memory_overview" });
	expect(overview.lastTidy).toBeNumber();
	expect(overview.notes.map((n) => n.topic).sort()).toEqual(["threads", "work"]);
	await engine.shutdown();
}, T);

test("tidy runs after a quiet spell, reads each part of a thread once, and skips small talk", async () => {
	const engine = start();
	const plan = { profile: [{ op: "add", text: "Has a dog named Biscuit" }], goals: [], notes: [], recap: null };
	await engine.configure({
		memoryTidy: true,
		faux: { tidyIdleMs: 50, replies: [{ text: "Cute!" }, { text: JSON.stringify(plan) }, { text: "Bye." }] },
	});
	let from = engine.records.length;
	await engine.prompt("My dog Biscuit needs a walk at six every evening, remember that.");
	expect(await engine.waitFor((r) => r.type === "memory_tidy" && r.state !== "running", from)).toMatchObject({ state: "done", changed: true });
	expect(read(join(engine.dataDir, "memory", "PROFILE.md"))).toBe("# Profile\n\n- Has a dog named Biscuit\n");
	from = engine.records.length;
	await engine.prompt("thanks");
	// Too little new text: no model call (the script has nothing left for one), nothing changes.
	expect(await engine.waitFor((r) => r.type === "memory_tidy" && r.state !== "running", from)).toMatchObject({ state: "done", changed: false });
	await engine.shutdown();
}, T);

test("a tidy that fails reports it and leaves memory alone", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [{ text: "ok" }, { text: "not json at all" }] } });
	await engine.prompt("I prefer answers in metric units and short paragraphs, always.");
	const from = engine.records.length;
	expect(await engine.callOk({ type: "memory_tidy" })).toEqual({ changed: false });
	expect(engine.records.slice(from).find((r) => r.type === "memory_tidy" && r.state === "failed")).toBeTruthy();
	expect(existsSync(join(engine.dataDir, "memory", "PROFILE.md"))).toBe(false);
	await engine.shutdown();
}, T);

test("Settings: overview, edit a core file, delete a note, forget everything", async () => {
	const engine = start();
	shellEmbedder(engine);
	await engine.configure();
	const store = new MemoryStore(engine.dataDir);
	store.save({ title: "Oat milk", topic: "food", content: "Prefers oat milk." }, "x");
	store.save({ title: "Rye", topic: "food", content: "Likes rye bread." }, "x");
	let from = engine.records.length;
	await engine.callOk({ type: "memory_core_set", which: "goals", text: "- Run a marathon\n" });
	expect(await engine.waitFor((r) => r.type === "memory_changed", from)).toEqual({ type: "memory_changed", reason: "edit" });
	let overview = await engine.callOk<MemoryOverview>({ type: "memory_overview" });
	expect(overview.goals).toBe("- Run a marathon");
	expect(read(join(engine.dataDir, "memory", "GOALS.md"))).toBe("# Goals\n\n- Run a marathon\n");
	expect(overview.notes.map((n) => n.title).sort()).toEqual(["Oat milk", "Rye"]);
	expect(overview.indexed.notes).toBe(2);
	const rye = overview.notes.find((n) => n.title === "Rye");
	await engine.callOk({ type: "memory_note_delete", topic: "food", noteId: rye?.id });
	expect(read(join(engine.dataDir, "memory", "food.md"))).not.toContain("rye");
	expect((await engine.call({ type: "memory_note_delete", topic: "food", noteId: rye?.id })).ok).toBe(false);
	from = engine.records.length;
	await engine.callOk({ type: "memory_forget_all" });
	expect(await engine.waitFor((r) => r.type === "memory_changed" && r.reason === "forget", from)).toBeTruthy();
	overview = await engine.callOk<MemoryOverview>({ type: "memory_overview" });
	expect(overview).toMatchObject({ profile: "", goals: "", recap: "", notes: [], indexed: { notes: 0, embedded: 0 }, lastTidy: null });
	await engine.shutdown();
}, T);

test("Esc while memory is being searched stops the prompt before it goes out", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [{ text: "should not run" }] } });
	new MemoryStore(engine.dataDir).save({ title: "Oat milk", topic: "food", content: "Prefers oat milk in coffee." }, "x");
	// Prime vectors so the next search waits for the (slow) embedder.
	shellEmbedder(engine);
	await engine.call({ type: "memory_overview" });
	let release: (() => void) | undefined;
	engine.onRequest = (request: Request) => {
		if (request.method !== "embed") return undefined;
		const texts = request.params.texts;
		if (!request.params.query) return { ok: true, data: { vectors: texts.map((t) => encode(fakeVector(t))) } };
		release = () => engine.send({ type: "response", id: request.id, ok: true, data: { vectors: texts.map((t) => encode(fakeVector(t))) } });
		return undefined;
	};
	// Let the background embedding finish.
	await new Promise((r) => setTimeout(r, 200));
	const from = engine.records.length;
	engine.send({ type: "prompt", id: "p-esc", text: "milk for coffee" });
	await engine.waitFor((r) => r.type === "thinking" && r.id === "p-esc", from);
	await engine.callOk({ type: "abort" });
	release?.();
	expect(await engine.waitFor((r) => r.type === "reply_end" && r.id === "p-esc", from)).toMatchObject({ aborted: true, text: "" });
	expect(engine.records.slice(from).some((r: OutboundMessage) => r.type === "text_delta")).toBe(false);
	await engine.shutdown();
}, T);
