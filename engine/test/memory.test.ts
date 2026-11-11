import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSection, ensureStarterFiles, indexLine, MemoryStore, topicSlug, updateIndex } from "../src/memory.ts";
import type { OutboundMessage, TranscriptItem, VoiceProfileInfo } from "../src/protocol.ts";
import { profileName, VoiceProfiles } from "../src/voice.ts";
import { EngineProcess } from "./harness.ts";

const running: EngineProcess[] = [];
function start(): EngineProcess {
	const engine = EngineProcess.start();
	running.push(engine);
	return engine;
}
afterEach(() => {
	for (const engine of running.splice(0)) {
		try {
			engine.proc.kill();
		} catch {}
	}
});

const T = 30_000;
const echo = { echoSystemPrompt: true };
const save = (title: string, topic: string, content: string) => ({
	toolCalls: [{ name: "memory_save", arguments: { title, topic, content } }],
});
const read = (path: string) => readFileSync(path, "utf8");

// ───────────────────────────── pure parts ─────────────────────────────

test("topic slugs, and path traversal is rejected", () => {
	expect(topicSlug("Project Atlas")).toBe("project-atlas");
	expect(topicSlug("food.md")).toBe("food");
	for (const bad of ["../etc", "a/b", "a\\b", "..", "", "  ", "MEMORY", "memory.md", "!!!"]) expect(() => topicSlug(bad)).toThrow();
	expect(() => profileName("../x")).toThrow();
	expect(() => profileName("a/b")).toThrow();
	expect(profileName("work.md")).toBe("work");
});

test("the index keeps one line per topic and drops the oldest over the cap", () => {
	let index = "";
	for (let i = 0; i < 5; i++) index = updateIndex(index, `t${i}`, indexLine(`T${i}`, `t${i}`, `fact ${i}`), 3);
	expect(index).toBe("- [T2](t2.md): fact 2\n- [T3](t3.md): fact 3\n- [T4](t4.md): fact 4\n");
	index = updateIndex(index, "t2", indexLine("T2b", "t2", "newer\nsecond line"), 3);
	expect(index).toBe("- [T3](t3.md): fact 3\n- [T4](t4.md): fact 4\n- [T2b](t2.md): newer second line\n");
	expect(appendSection(null, "food", "## s\n")).toBe("# food\n\n## s\n");
});

test("store: save, read, undo restores exactly; undo after a later save removes just that save", () => {
	const dir = mkdtempSync(join(tmpdir(), "winku-mem-"));
	ensureStarterFiles(dir);
	const store = new MemoryStore(dir, () => new Date("2026-11-11T10:00:00Z"));
	const a = store.save({ title: "Likes tea", topic: "Food", content: "Green tea, no sugar." }, "s1");
	expect(read(join(dir, "memory", "food.md"))).toBe("# food\n\n## 2026-11-11: Likes tea\n\nGreen tea, no sugar.\n");
	expect(store.index()).toBe("- [Likes tea](food.md): Green tea, no sugar.\n");
	expect(store.read("food")).toContain("Green tea");
	expect(() => store.read("nope")).toThrow('No memory file "nope.md"');
	const b = store.save({ title: "Hates olives", topic: "food", content: "No olives." }, "s1");
	expect(() => store.undo(a.saveId, "s2")).toThrow("another thread");
	store.undo(a.saveId, "s1");
	expect(read(join(dir, "memory", "food.md"))).toBe("# food\n\n## 2026-11-11: Hates olives\n\nNo olives.\n");
	expect(store.index()).toBe("- [Hates olives](food.md): No olives.\n");
	expect(() => store.undo(a.saveId, "s1")).toThrow("Already undone");
	store.undo(b.saveId, "s1");
	expect(store.index()).toBe("");
	expect(existsSync(join(dir, "memory", "food.md"))).toBe(false);
	expect([...store.undone()].sort()).toEqual([a.saveId, b.saveId].sort());
});

test("voice store: list, propose, accept and dismiss", () => {
	const dir = mkdtempSync(join(tmpdir(), "winku-voice-"));
	ensureStarterFiles(dir);
	const voice = new VoiceProfiles(dir);
	expect(voice.list()).toEqual([
		{ name: "casual", summary: "Casual" },
		{ name: "work", summary: "Work" },
	]);
	const p = voice.propose({ profile: "work", content: "# Work\n- Shorter.", reason: "r" });
	expect(p.current).toContain("# Work");
	expect(voice.decide(p.proposalId, true)).toEqual({ written: true });
	expect(read(join(dir, "voice", "work.md"))).toBe("# Work\n- Shorter.\n");
	expect(voice.decide(p.proposalId, true)).toEqual({ written: false });
});

// ───────────────────────────── through the engine ─────────────────────────────

test("starter files are created once and never overwritten", async () => {
	const engine = start();
	await engine.configure();
	const d = engine.dataDir;
	for (const f of ["about-me.md", "voice/casual.md", "voice/work.md", "memory/MEMORY.md"]) expect(existsSync(join(d, f))).toBe(true);
	expect(read(join(d, "memory", "MEMORY.md"))).toBe("");
	writeFileSync(join(d, "about-me.md"), "I am Sam.\n");
	writeFileSync(join(d, "voice", "work.md"), "mine\n");
	await engine.shutdown();
	const again = engine.restart();
	running.push(again);
	await again.configure();
	expect(read(join(d, "about-me.md"))).toBe("I am Sam.\n");
	expect(read(join(d, "voice", "work.md"))).toBe("mine\n");
	await again.shutdown();
}, T);

test("memory_save writes the topic and index, emits memory_saved, and shows in the transcript", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [save("Likes tea", "food", "Green tea, no sugar."), { text: "Noted. <mood:happy>" }] } });
	const { end } = await engine.prompt("remember I like green tea");
	const saved = engine.records.find((r) => r.type === "memory_saved") as Extract<OutboundMessage, { type: "memory_saved" }>;
	expect(saved).toMatchObject({ id: end.id, title: "Likes tea" });
	expect(read(join(engine.dataDir, "memory", "food.md"))).toContain("Green tea, no sugar.");
	expect(read(join(engine.dataDir, "memory", "MEMORY.md"))).toBe("- [Likes tea](food.md): Green tea, no sugar.\n");
	const transcript = await engine.callOk<TranscriptItem[]>({ type: "transcript" });
	expect(transcript.map((t) => t.kind)).toEqual(["user", "memory_saved", "assistant"]);
	expect(transcript[1]).toMatchObject({ saveId: saved.saveId, title: "Likes tea", undone: false });
	await engine.shutdown();
}, T);

test("a rejected memory_save (path traversal) writes nothing and stays a failed tool row", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [save("x", "../../evil", "y"), { text: "ok" }] } });
	await engine.prompt("save");
	expect(engine.records.some((r) => r.type === "memory_saved")).toBe(false);
	expect(readdirSync(join(engine.dataDir, "memory"))).toEqual(["MEMORY.md"]);
	expect(existsSync(join(engine.dataDir, "evil.md"))).toBe(false);
	const transcript = await engine.callOk<TranscriptItem[]>({ type: "transcript" });
	expect(transcript.find((t) => t.kind === "tool")).toMatchObject({ name: "memory_save", ok: false });
	await engine.shutdown();
}, T);

test("memory_read returns the topic file to the model", async () => {
	const engine = start();
	await engine.configure({
		faux: { replies: [save("Likes tea", "food", "Green tea."), { text: "ok" }, { toolCalls: [{ name: "memory_read", arguments: { topic: "food" } }] }, { text: "done" }] },
	});
	await engine.prompt("one");
	await engine.prompt("two");
	const transcript = await engine.callOk<TranscriptItem[]>({ type: "transcript" });
	const tool = transcript.find((t) => t.kind === "tool");
	expect(tool).toMatchObject({ name: "memory_read", ok: true });
	expect(tool?.kind === "tool" && tool.detail).toContain("Green tea.");
	await engine.shutdown();
}, T);

test("memory_undo restores, survives a restart, and marks the transcript row", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [save("A", "food", "Tea."), { text: "ok" }, save("B", "work", "Atlas."), { text: "ok" }] } });
	await engine.prompt("one");
	await engine.prompt("two");
	const [a, b] = engine.records.filter((r) => r.type === "memory_saved") as Extract<OutboundMessage, { type: "memory_saved" }>[];
	let from = engine.records.length;
	await engine.callOk({ type: "memory_undo", saveId: b?.saveId });
	expect(await engine.waitFor((r) => r.type === "memory_undone", from)).toEqual({ type: "memory_undone", saveId: b?.saveId as string });
	expect(existsSync(join(engine.dataDir, "memory", "work.md"))).toBe(false);
	expect(read(join(engine.dataDir, "memory", "MEMORY.md"))).toBe("- [A](food.md): Tea.\n");
	await engine.shutdown();

	const again = engine.restart();
	running.push(again);
	await again.configure();
	from = again.records.length;
	await again.callOk({ type: "memory_undo", saveId: a?.saveId });
	await again.waitFor((r) => r.type === "memory_undone", from);
	expect(read(join(engine.dataDir, "memory", "MEMORY.md"))).toBe("");
	expect(existsSync(join(engine.dataDir, "memory", "food.md"))).toBe(false);
	const rows = (await again.callOk<TranscriptItem[]>({ type: "transcript" })).filter((t) => t.kind === "memory_saved");
	expect(rows.map((r) => r.kind === "memory_saved" && r.undone)).toEqual([true, true]);
	expect(await again.call({ type: "memory_undo", saveId: a?.saveId })).toMatchObject({ ok: false });
	await again.shutdown();
}, T);

test("memory_undo refuses a save from another thread", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [save("A", "food", "Tea."), { text: "ok" }] } });
	await engine.prompt("one");
	const saved = engine.records.find((r) => r.type === "memory_saved") as Extract<OutboundMessage, { type: "memory_saved" }>;
	await engine.callOk({ type: "clear" });
	expect(await engine.call({ type: "memory_undo", saveId: saved.saveId })).toMatchObject({ ok: false });
	expect(read(join(engine.dataDir, "memory", "food.md"))).toContain("Tea.");
	await engine.shutdown();
}, T);

test("memory_forget_all wipes memory and keeps about-me and voice", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [save("A", "food", "Tea."), save("B", "work", "Atlas."), { text: "ok" }] } });
	await engine.prompt("one");
	expect(await engine.callOk({ type: "memory_forget_all" })).toEqual({ removed: 3 });
	expect(readdirSync(join(engine.dataDir, "memory"))).toEqual(["MEMORY.md"]);
	expect(read(join(engine.dataDir, "memory", "MEMORY.md"))).toBe("");
	expect(existsSync(join(engine.dataDir, "about-me.md"))).toBe(true);
	expect(existsSync(join(engine.dataDir, "voice", "work.md"))).toBe(true);
	await engine.shutdown();
}, T);

test("the system prompt snapshots about-me, voice and the index; frozen mid-thread, refreshed on clear", async () => {
	const engine = start();
	await engine.configure();
	writeFileSync(join(engine.dataDir, "about-me.md"), "I live in Lisbon.\n");
	writeFileSync(join(engine.dataDir, "memory", "MEMORY.md"), "- [Old](old.md): an old fact\n");
	await engine.callOk({ type: "clear" });
	await engine.configure({ faux: { replies: [echo, save("Likes tea", "food", "Green tea."), { text: "ok" }, echo, echo] } });
	const first = (await engine.prompt("p1")).end.text;
	expect(first).toContain("<about_me>\nI live in Lisbon.\n</about_me>");
	expect(first).toContain('<voice_profile name="casual">');
	expect(first).toContain('<voice_profile name="work">');
	expect(first).toContain("<memory_index>\n- [Old](old.md): an old fact\n</memory_index>");
	expect(first).toContain("memory_save");
	await engine.prompt("remember tea");
	expect((await engine.prompt("p3")).end.text).toBe(first);
	await engine.callOk({ type: "clear" });
	const fresh = (await engine.prompt("p4")).end.text;
	expect(fresh).toContain("- [Likes tea](food.md): Green tea.");
	await engine.shutdown();
}, T);

test("the starter about-me template stays out of the prompt", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [echo] } });
	expect((await engine.prompt("p")).end.text).not.toContain("<about_me>\n");
	await engine.shutdown();
}, T);

test("compaction refreshes the system prompt snapshot", async () => {
	const engine = start();
	await engine.configure({
		compactionReserveTokens: 1000,
		faux: { contextWindow: 3000, keepRecentTokens: 500, tokensPerSecond: 1_000_000, replies: [save("Likes tea", "food", "Green tea."), ...Array(20).fill(echo)] },
	});
	const first = (await engine.prompt("one")).end.text;
	expect(first).toStartWith("You are Winku");
	expect(first).not.toContain("Likes tea");
	// The echoed prompts fill the tiny window; pi compacts before a later request.
	for (let i = 0; i < 6 && !engine.records.some((r) => r.type === "compaction_end"); i++) await engine.prompt(`more ${i}`);
	expect(engine.records.find((r) => r.type === "compaction_end")).toMatchObject({ ok: true });
	const after = (await engine.prompt("after")).end.text;
	expect(after).toContain("- [Likes tea](food.md): Green tea.");
	expect((await engine.shutdown()).stderr).toBe("");
}, T);

test("voice_propose emits voice_proposal; accept writes, dismiss doesn't, clear drops pending", async () => {
	const engine = start();
	const propose = (content: string) => ({ toolCalls: [{ name: "voice_propose", arguments: { profile: "work", content, reason: "You asked." } }] });
	await engine.configure({ faux: { replies: [propose("# Work\n- v1"), { text: "Proposed." }, propose("# Work\n- v2"), { text: "Proposed." }, propose("# Work\n- v3"), { text: "Proposed." }] } });
	const original = read(join(engine.dataDir, "voice", "work.md"));
	const { end } = await engine.prompt("make work shorter");
	type Proposal = Extract<OutboundMessage, { type: "voice_proposal" }>;
	const p1 = engine.records.findLast((r) => r.type === "voice_proposal") as Proposal;
	expect(p1).toMatchObject({ id: end.id, profile: "work", content: "# Work\n- v1", current: original, reason: "You asked." });
	const transcript = await engine.callOk<TranscriptItem[]>({ type: "transcript" });
	expect(transcript.find((t) => t.kind === "tool")).toMatchObject({ name: "voice_propose", ok: true });
	expect(JSON.stringify(transcript)).toContain("Accept or Dismiss");

	await engine.prompt("again");
	const p2 = engine.records.findLast((r) => r.type === "voice_proposal") as Proposal;
	expect(await engine.callOk({ type: "voice_proposal_decision", proposalId: p2.proposalId, accept: false })).toEqual({ written: false });
	expect(read(join(engine.dataDir, "voice", "work.md"))).toBe(original);
	expect(await engine.callOk({ type: "voice_proposal_decision", proposalId: p1.proposalId, accept: true })).toEqual({ written: true });
	expect(read(join(engine.dataDir, "voice", "work.md"))).toBe("# Work\n- v1\n");

	await engine.prompt("third");
	const p3 = engine.records.findLast((r) => r.type === "voice_proposal") as Proposal;
	await engine.callOk({ type: "clear" });
	expect(await engine.callOk({ type: "voice_proposal_decision", proposalId: p3.proposalId, accept: true })).toEqual({ written: false });
	expect(read(join(engine.dataDir, "voice", "work.md"))).toBe("# Work\n- v1\n");
	await engine.shutdown();
}, T);

test("voice_list lists the profiles with a summary", async () => {
	const engine = start();
	await engine.configure();
	writeFileSync(join(engine.dataDir, "voice", "email.md"), "\n## Email to clients\n- formal\n");
	writeFileSync(join(engine.dataDir, "voice", "notes.txt"), "ignored");
	expect(await engine.callOk<VoiceProfileInfo[]>({ type: "voice_list" })).toEqual([
		{ name: "casual", summary: "Casual" },
		{ name: "email", summary: "Email to clients" },
		{ name: "work", summary: "Work" },
	]);
	await engine.shutdown();
}, T);
