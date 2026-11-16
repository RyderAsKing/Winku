// Memory (SPEC §9): the core files (PROFILE.md, GOALS.md, RECAP.md), the notes in
// memory\<topic>.md with their MEMORY.md index, the starter files, save / read / undo /
// forget-all, and the memory tools. The markdown files are the memory; recall.ts only indexes them.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { EngineError } from "./runtime.ts";

/** About this many index lines are kept; the oldest drop off (their topic files stay). */
export const INDEX_MAX_LINES = 150;
const INDEX_FILE = "MEMORY.md";

/** The core files: always in the system prompt (prompt.ts), kept small. */
export type CoreKind = "profile" | "goals" | "recap";
export const CORE_FILES: Record<CoreKind, string> = { profile: "PROFILE.md", goals: "GOALS.md", recap: "RECAP.md" };
const CORE_HEADINGS: Record<CoreKind, string> = { profile: "# Profile", goals: "# Goals", recap: "# Recap" };
/** Characters each core file may take in the prompt (about 4 per token). Tidy keeps them under. */
export const CORE_BUDGET: Record<CoreKind, number> = { profile: 2400, goals: 1200, recap: 1200 };
/** Topic names that would clash with the index or a core file (case-insensitively, as on Windows). */
const RESERVED_SLUGS = new Set(["memory", "profile", "goals", "recap"]);
/** Where tidy keeps one recap per past thread, recalled like any other note. */
export const THREADS_TOPIC = "threads";
const IMPORTANT = "<!-- important -->";

const ABOUT_ME = `<!--
About me. Winku reads this at the start of every thread; it never writes it.
Write anything that helps: your name, what you do, where you are, how you like answers.
-->
`;

const CASUAL = `# Casual
- Short sentences, plain words.
- Lowercase is fine for quick messages; no exclamation marks.
- No emoji unless the other person used one first.
`;

const WORK = `# Work
- Clear and polite, but not stiff. Get to the point in the first sentence.
- Full sentences with normal capitalisation; no slang, no emoji.
- End with the next step or the question that needs an answer.
`;

/** Create about-me.md, voice\casual.md, voice\work.md and memory\MEMORY.md if missing. Never overwrites. */
export function ensureStarterFiles(dataDir: string): void {
	mkdirSync(join(dataDir, "voice"), { recursive: true });
	mkdirSync(join(dataDir, "memory"), { recursive: true });
	moveReservedTopics(join(dataDir, "memory"));
	const files: [string, string][] = [
		[join(dataDir, "about-me.md"), ABOUT_ME],
		[join(dataDir, "voice", "casual.md"), CASUAL],
		[join(dataDir, "voice", "work.md"), WORK],
		[join(dataDir, "memory", INDEX_FILE), ""],
	];
	for (const [path, content] of files) {
		try {
			writeFileSync(path, content, { flag: "wx" });
		} catch {
			// Exists already: it is the user's now.
		}
	}
}

/**
 * Before 0.2 a topic could be called "profile", "goals" or "recap"; those names are the core files
 * now (and the same file on Windows). Rename such a topic to "<name>-notes" and fix its index line.
 */
function moveReservedTopics(dir: string): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const stem = name.slice(0, -3);
		// Exact lower-case names only: the core files themselves are upper case.
		if (!name.endsWith(".md") || !(stem in CORE_FILES)) continue;
		let target = `${stem}-notes`;
		for (let n = 2; existsSync(join(dir, `${target}.md`)); n++) target = `${stem}-notes-${n}`;
		renameSync(join(dir, name), join(dir, `${target}.md`));
		const indexPath = join(dir, INDEX_FILE);
		const index = readOrNull(indexPath);
		if (index) writeFileSync(indexPath, index.split(`](${stem}.md)`).join(`](${target}.md)`));
	}
}

// ───────────────────────────── pure parts ─────────────────────────────

/** A topic name → file stem. Rejects anything that looks like a path, and the index itself. */
export function topicSlug(topic: string): string {
	const raw = topic.trim().replace(/\.md$/i, "");
	if (/[\\/]|\.\./.test(raw)) throw new EngineError(`Invalid memory topic "${topic}"`, "engine");
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");
	if (!slug || RESERVED_SLUGS.has(slug)) throw new EngineError(`Invalid memory topic "${topic}"`, "engine");
	return slug;
}

function oneLine(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function indexLine(title: string, slug: string, content: string): string {
	const hook = oneLine(content, 100);
	return `- [${oneLine(title, 80).replace(/[[\]]/g, "")}](${slug}.md)${hook ? `: ${hook}` : ""}`;
}

/** Add or replace the line for `slug` at the end, then drop the oldest index lines over the cap. */
export function updateIndex(index: string, slug: string, line: string, max = INDEX_MAX_LINES): string {
	const target = `](${slug}.md)`;
	const lines = index.split("\n").filter((l) => l.trim() && !(l.startsWith("- [") && l.includes(target)));
	lines.push(line);
	let entries = lines.filter((l) => l.startsWith("- [")).length;
	const kept: string[] = [];
	for (const l of lines) {
		if (entries > max && l.startsWith("- [")) {
			entries--;
			continue;
		}
		kept.push(l);
	}
	return `${kept.join("\n")}\n`;
}

export function dateSection(title: string, content: string, date: Date, important = false): string {
	return `## ${date.toISOString().slice(0, 10)}: ${oneLine(title, 80)}${important ? ` ${IMPORTANT}` : ""}\n\n${content.trim()}\n`;
}

/** One dated section of a topic file, as recall and Settings see it. */
export interface Note {
	/** Hash of topic, heading and body: stable until the section is edited. */
	id: string;
	topic: string;
	title: string;
	/** ms since the epoch: the heading's date, else the file's modification time. */
	date: number;
	important: boolean;
	body: string;
}

const HEADING = /^## (?:(\d{4}-\d{2}-\d{2}):\s*)?(.*)$/;

/** Split a topic file into notes at its "## " headings. Text before the first one is a note titled by the topic. */
export function parseNotes(topic: string, text: string, fallbackDate: number): Note[] {
	const notes: Note[] = [];
	let heading: string | undefined;
	let body: string[] = [];
	const flush = () => {
		const content = body.join("\n").trim();
		if (heading === undefined && !content) return;
		const raw = heading ?? "";
		const match = HEADING.exec(raw);
		const important = raw.includes(IMPORTANT);
		const title = (match?.[2] ?? "").replace(IMPORTANT, "").trim() || topic;
		const date = match?.[1] ? Date.parse(`${match[1]}T12:00:00Z`) : fallbackDate;
		if (!content && !title) return;
		const id = createHash("sha1").update(`${topic}\0${raw}\0${content}`).digest("hex").slice(0, 12);
		notes.push({ id, topic, title, date: Number.isFinite(date) ? date : fallbackDate, important, body: content });
	};
	for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
		if (line.startsWith("## ")) {
			flush();
			heading = line;
			body = [];
		} else if (heading === undefined && /^# /.test(line)) {
			// The file's "# topic" title.
		} else {
			body.push(line);
		}
	}
	flush();
	return notes;
}

/** Remove the note with this id from a topic file's text. Undefined when there is no such note. */
export function removeNote(topic: string, text: string, id: string): string | undefined {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	// Section boundaries: [start, end) line ranges, the first one possibly headless.
	const starts: number[] = [];
	let sawHeading = false;
	lines.forEach((line, i) => {
		if (line.startsWith("## ")) {
			starts.push(i);
			sawHeading = true;
		}
	});
	const firstBodyLine = lines.findIndex((l) => !/^# /.test(l));
	const ranges: [number, number][] = [];
	const preambleEnd = starts[0] ?? lines.length;
	if (firstBodyLine >= 0 && firstBodyLine < preambleEnd) ranges.push([firstBodyLine, preambleEnd]);
	starts.forEach((start, i) => ranges.push([start, starts[i + 1] ?? lines.length]));
	for (const [start, end] of ranges) {
		const section = lines.slice(start, end).join("\n");
		const [note] = parseNotes(topic, section, 0);
		if (note?.id !== id) continue;
		const kept = [...lines.slice(0, start), ...lines.slice(end)];
		// Keep a blank line where the two sides meet, e.g. between the title and the next section.
		if (start > 0 && kept[start - 1]?.trim() && kept[start]?.trim()) kept.splice(start, 0, "");
		const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
		return sawHeading || out.trim() ? `${out}\n` : "";
	}
	return undefined;
}

// ───────────────────────────── core files ─────────────────────────────

/** The lines of a profile or goals file: every non-empty line except headings and comments, without its bullet. */
export function coreLines(text: string): string[] {
	return text
		.replace(/<!--[\s\S]*?-->/g, "")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"))
		.map((l) => l.replace(/^[-*•]\s+/, "").trim())
		.filter(Boolean);
}

/** A profile or goals file from its lines. */
export function coreFile(kind: "profile" | "goals", lines: string[]): string {
	const body = lines.map((l) => `- ${oneLine(l, 300)}`).join("\n");
	return body ? `${CORE_HEADINGS[kind]}\n\n${body}\n` : "";
}

/** A core file as Settings edits it: without its "# " heading. */
export function coreBody(kind: CoreKind, text: string): string {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines[0]?.trim() === CORE_HEADINGS[kind]) lines.shift();
	return lines.join("\n").trim();
}

/** A core file from what Settings edited: the heading back on top; empty when there is nothing. */
export function coreFromBody(kind: CoreKind, body: string): string {
	const text = body.replace(/\r\n/g, "\n").trim();
	return text ? `${CORE_HEADINGS[kind]}\n\n${text}\n` : "";
}

/** The recap file from its text. */
export function recapFile(text: string): string {
	const body = text.trim();
	return body ? `${CORE_HEADINGS.recap}\n\n${body}\n` : "";
}

/** What the prompt shows of a core file: the text without its "# " heading and comments, within budget. */
export function coreForPrompt(kind: CoreKind, text: string): string {
	const body = text
		.replace(/<!--[\s\S]*?-->/g, "")
		.split(/\r?\n/)
		.filter((l) => l.trim() !== CORE_HEADINGS[kind])
		.join("\n")
		.trim();
	const budget = CORE_BUDGET[kind];
	if (body.length <= budget) return body;
	// Keep whole lines from the top; what's cut is the oldest or least important (tidy orders them).
	const kept: string[] = [];
	let used = 0;
	for (const line of body.split("\n")) {
		if (used + line.length + 1 > budget) break;
		kept.push(line);
		used += line.length + 1;
	}
	return kept.length ? kept.join("\n") : `${body.slice(0, budget - 1)}…`;
}

/** Loose comparison for a line the model quotes back ("replaces"). */
function sameLine(a: string, b: string): boolean {
	const norm = (s: string) => s.replace(/^[-*•]\s+/, "").replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim().toLowerCase();
	return norm(a) === norm(b);
}

/**
 * Add `content` to `lines`, replacing the line `replaces` when given. Empty content with `replaces`
 * removes that line. Returns the new lines plus what was added and removed.
 */
export function editCoreLines(
	lines: string[],
	content: string,
	replaces: string | undefined,
): { lines: string[]; added?: string; removed?: string } {
	const text = oneLine(content, 300);
	const out = [...lines];
	let removed: string | undefined;
	if (replaces?.trim()) {
		const at = out.findIndex((l) => sameLine(l, replaces));
		if (at < 0) {
			if (!text) throw new EngineError(`No line "${oneLine(replaces, 80)}" to remove`, "engine");
		} else {
			removed = out[at];
			if (text) out[at] = text;
			else out.splice(at, 1);
			return { lines: out, ...(text ? { added: text } : {}), removed };
		}
	}
	if (!text) throw new EngineError("A memory needs content", "engine");
	if (out.some((l) => sameLine(l, text))) return { lines: out };
	out.push(text);
	return { lines: out, added: text };
}

/** Append a section to a topic file (a new file gets a "# topic" heading). */
export function appendSection(existing: string | null, slug: string, section: string): string {
	const base = existing ?? `# ${slug}\n`;
	return `${base.trimEnd()}\n\n${section}`;
}

// ───────────────────────────── store ─────────────────────────────

/** One line of engine\memory-undo.jsonl. */
type UndoLine =
	| {
			type: "save";
			saveId: string;
			sessionId: string;
			title: string;
			slug: string;
			line: string;
			section: string;
			indexBefore: string;
			indexAfter: string;
			topicBefore: string | null;
			topicAfter: string;
	  }
	| {
			/** A profile line or goal: the file before and after, and the line added and removed. */
			type: "core";
			saveId: string;
			sessionId: string;
			title: string;
			kind: "profile" | "goals";
			before: string | null;
			after: string;
			added?: string;
			removed?: string;
	  }
	| { type: "undone"; saveId: string };

export interface SaveResult {
	saveId: string;
	slug: string;
	title: string;
}

function readOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

export class MemoryStore {
	readonly dir: string;
	private readonly undoPath: string;

	constructor(
		dataDir: string,
		private readonly now: () => Date = () => new Date(),
	) {
		this.dir = join(dataDir, "memory");
		this.undoPath = join(dataDir, "engine", "memory-undo.jsonl");
	}

	private get indexPath(): string {
		return join(this.dir, INDEX_FILE);
	}

	index(): string {
		return readOrNull(this.indexPath) ?? "";
	}

	corePath(kind: CoreKind): string {
		return join(this.dir, CORE_FILES[kind]);
	}

	/** A core file's text ("" when missing). */
	core(kind: CoreKind): string {
		return readOrNull(this.corePath(kind)) ?? "";
	}

	/** Replace a core file (Settings, tidy). Empty text removes it. */
	setCore(kind: CoreKind, text: string): void {
		mkdirSync(this.dir, { recursive: true });
		if (!text.trim()) rmSync(this.corePath(kind), { force: true });
		else writeFileSync(this.corePath(kind), text.endsWith("\n") ? text : `${text}\n`);
	}

	/** Topic files (not the index or a core file), by slug. */
	topics(): string[] {
		let names: string[];
		try {
			names = readdirSync(this.dir);
		} catch {
			return [];
		}
		const core = new Set(Object.values(CORE_FILES).map((f) => f.toLowerCase()));
		return names
			.filter((n) => n.endsWith(".md") && n !== INDEX_FILE && !core.has(n.toLowerCase()) && !n.startsWith("."))
			.map((n) => n.slice(0, -3))
			.sort();
	}

	/** Every note in every topic file. */
	notes(): Note[] {
		return this.topics().flatMap((topic) => {
			const path = join(this.dir, `${topic}.md`);
			const text = readOrNull(path);
			if (text === null) return [];
			let mtime = Date.now();
			try {
				mtime = statSync(path).mtimeMs;
			} catch {}
			return parseNotes(topic, text, mtime);
		});
	}

	/** Delete one note (Settings). An emptied topic file goes, with its index line. */
	deleteNote(topic: string, noteId: string): void {
		const slug = topicSlug(topic);
		const path = join(this.dir, `${slug}.md`);
		const text = readOrNull(path);
		const next = text === null ? undefined : removeNote(slug, text, noteId);
		if (next === undefined) throw new EngineError("That note is gone already", "engine");
		if (parseNotes(slug, next, 0).length) {
			writeFileSync(path, next);
			return;
		}
		rmSync(path, { force: true });
		const index = this.index();
		const kept = index.split("\n").filter((l) => l.trim() && !(l.startsWith("- [") && l.includes(`](${slug}.md)`)));
		writeFileSync(this.indexPath, kept.length ? `${kept.join("\n")}\n` : "");
	}

	/** Add, reword or drop a profile line or goal (memory_save with kind profile/goal). */
	saveCore(
		kind: "profile" | "goals",
		input: { title: string; content: string; replaces?: string },
		sessionId: string,
	): SaveResult {
		const title = oneLine(input.title, 80);
		if (!title) throw new EngineError("A memory needs a title", "engine");
		const before = readOrNull(this.corePath(kind));
		const edit = editCoreLines(coreLines(before ?? ""), input.content, input.replaces);
		const after = coreFile(kind, edit.lines);
		mkdirSync(this.dir, { recursive: true });
		if (after) writeFileSync(this.corePath(kind), after);
		else rmSync(this.corePath(kind), { force: true });
		const saveId = randomUUID();
		this.log({
			type: "core",
			saveId,
			sessionId,
			title,
			kind,
			before,
			after,
			...(edit.added ? { added: edit.added } : {}),
			...(edit.removed ? { removed: edit.removed } : {}),
		});
		return { saveId, slug: CORE_FILES[kind].slice(0, -3), title };
	}

	/** Append a note without an undo entry (tidy). Returns the note's topic slug. */
	addNote(input: { title: string; topic: string; content: string; important?: boolean }): string {
		const slug = topicSlug(input.topic);
		const title = oneLine(input.title, 80);
		if (!title || !input.content.trim()) throw new EngineError("A note needs a title and content", "engine");
		mkdirSync(this.dir, { recursive: true });
		const topicPath = join(this.dir, `${slug}.md`);
		writeFileSync(topicPath, appendSection(readOrNull(topicPath), slug, dateSection(title, input.content, this.now(), input.important)));
		writeFileSync(this.indexPath, updateIndex(this.index(), slug, indexLine(title, slug, input.content)));
		return slug;
	}

	/** Write or replace the recap of one thread in threads.md (tidy), keyed by its session id. */
	saveThreadRecap(sessionId: string, title: string, summary: string, date: Date): void {
		mkdirSync(this.dir, { recursive: true });
		const path = join(this.dir, `${THREADS_TOPIC}.md`);
		const marker = `<!-- thread:${sessionId} -->`;
		const section = `## ${date.toISOString().slice(0, 10)}: ${oneLine(title, 80)}\n\n${marker}\n${summary.trim()}\n`;
		const existing = readOrNull(path);
		let next: string;
		if (existing?.includes(marker)) {
			const lines = existing.split("\n");
			const markerAt = lines.findIndex((l) => l.trim() === marker);
			let start = markerAt;
			while (start > 0 && !lines[start]?.startsWith("## ")) start--;
			let end = markerAt + 1;
			while (end < lines.length && !lines[end]?.startsWith("## ")) end++;
			next = [...lines.slice(0, start), ...section.trimEnd().split("\n"), "", ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
			next = `${next.trimEnd()}\n`;
		} else {
			next = appendSection(existing, THREADS_TOPIC, section);
		}
		writeFileSync(path, next);
		writeFileSync(this.indexPath, updateIndex(this.index(), THREADS_TOPIC, indexLine("Past threads", THREADS_TOPIC, `Recaps of earlier conversations; latest: ${title}`)));
	}

	save(input: { title: string; topic: string; content: string; important?: boolean }, sessionId: string): SaveResult {
		const title = oneLine(input.title, 80);
		if (!title) throw new EngineError("A memory needs a title", "engine");
		if (!input.content.trim()) throw new EngineError("A memory needs content", "engine");
		const slug = topicSlug(input.topic);
		mkdirSync(this.dir, { recursive: true });
		const topicPath = join(this.dir, `${slug}.md`);
		const indexBefore = this.index();
		const topicBefore = readOrNull(topicPath);
		const section = dateSection(title, input.content, this.now(), input.important === true);
		const line = indexLine(title, slug, input.content);
		const topicAfter = appendSection(topicBefore, slug, section);
		const indexAfter = updateIndex(indexBefore, slug, line);
		writeFileSync(topicPath, topicAfter);
		writeFileSync(this.indexPath, indexAfter);
		const saveId = randomUUID();
		this.log({ type: "save", saveId, sessionId, title, slug, line, section, indexBefore, indexAfter, topicBefore, topicAfter });
		return { saveId, slug, title };
	}

	read(topic: string): string {
		const slug = topicSlug(topic);
		const content = readOrNull(join(this.dir, `${slug}.md`));
		if (content === null) throw new EngineError(`No memory file "${slug}.md"`, "engine");
		return content;
	}

	/** Undo a save from the current thread. Restores both files if untouched since, else removes just that save. */
	undo(saveId: string, sessionId: string): void {
		const lines = this.readLog();
		const save = lines.find((l) => (l.type === "save" || l.type === "core") && l.saveId === saveId);
		if (!save || save.type === "undone") throw new EngineError("Nothing to undo", "engine");
		if (lines.some((l) => l.type === "undone" && l.saveId === saveId)) throw new EngineError("Already undone", "engine");
		if (save.sessionId !== sessionId) throw new EngineError("That memory was saved in another thread", "engine");
		if (save.type === "core") {
			this.undoCore(save);
			this.log({ type: "undone", saveId });
			return;
		}
		const topicPath = join(this.dir, `${save.slug}.md`);
		const index = this.index();
		const topic = readOrNull(topicPath);
		if (index === save.indexAfter && topic === save.topicAfter) {
			writeFileSync(this.indexPath, save.indexBefore);
			if (save.topicBefore === null) rmSync(topicPath, { force: true });
			else writeFileSync(topicPath, save.topicBefore);
		} else {
			let topicRemains = false;
			if (topic !== null) {
				const rest = topic.replace(`\n\n${save.section}`, "\n").replace(save.section, "");
				topicRemains = !!rest.replace(`# ${save.slug}`, "").trim();
				if (topicRemains) writeFileSync(topicPath, rest);
				else rmSync(topicPath, { force: true });
			}
			if (index.includes(save.line)) {
				// Put back the topic's earlier line, unless nothing is left in the topic.
				const previous = !topicRemains ? undefined : save.indexBefore.split("\n").find((l) => l.startsWith("- [") && l.includes(`](${save.slug}.md)`));
				const kept = index.split("\n").filter((l) => l.trim() && l !== save.line);
				const next = previous ? updateIndex(kept.join("\n"), save.slug, previous) : kept.length ? `${kept.join("\n")}\n` : "";
				writeFileSync(this.indexPath, next);
			}
		}
		this.log({ type: "undone", saveId });
	}

	private undoCore(save: Extract<UndoLine, { type: "core" }>): void {
		const path = this.corePath(save.kind);
		const current = readOrNull(path) ?? "";
		let next: string;
		if (current === save.after) {
			next = save.before ?? "";
		} else {
			// Edited since (by hand or by tidy): take out just this change.
			let lines = coreLines(current);
			if (save.added) {
				const at = lines.findIndex((l) => sameLine(l, save.added as string));
				if (at >= 0) {
					if (save.removed) lines[at] = save.removed;
					else lines.splice(at, 1);
				}
			} else if (save.removed && !lines.some((l) => sameLine(l, save.removed as string))) {
				lines = [...lines, save.removed];
			}
			next = coreFile(save.kind, lines);
		}
		if (next) writeFileSync(path, next);
		else rmSync(path, { force: true });
	}

	undone(): Set<string> {
		return new Set(this.readLog().flatMap((l) => (l.type === "undone" ? [l.saveId] : [])));
	}

	/** Delete everything in memory\ and recreate an empty MEMORY.md. Returns the number of files removed. */
	forgetAll(): number {
		let removed = 0;
		const count = (path: string): void => {
			if (statSync(path).isDirectory()) for (const name of readdirSync(path)) count(join(path, name));
			else removed++;
		};
		if (existsSync(this.dir)) {
			for (const name of readdirSync(this.dir)) {
				const path = join(this.dir, name);
				count(path);
				rmSync(path, { recursive: true, force: true });
			}
		}
		mkdirSync(this.dir, { recursive: true });
		writeFileSync(this.indexPath, "");
		rmSync(this.undoPath, { force: true });
		return removed;
	}

	private log(line: UndoLine): void {
		mkdirSync(dirname(this.undoPath), { recursive: true });
		appendFileSync(this.undoPath, `${JSON.stringify(line)}\n`);
	}

	private readLog(): UndoLine[] {
		const text = readOrNull(this.undoPath);
		if (!text) return [];
		const lines: UndoLine[] = [];
		for (const raw of text.split("\n")) {
			if (!raw.trim()) continue;
			try {
				lines.push(JSON.parse(raw) as UndoLine);
			} catch {
				// Skip a torn line.
			}
		}
		return lines;
	}
}

// ───────────────────────────── tools ─────────────────────────────

/** details of a successful memory_save tool result; the transcript reads it back. */
export interface MemorySaveDetails {
	saveId: string;
	title: string;
	topic: string;
}

export function memoryTools(
	store: () => MemoryStore,
	sessionId: () => string,
	onSaved: (save: SaveResult) => void,
	search: (query: string) => Promise<string>,
) {
	const save = defineTool({
		name: "memory_save",
		label: "Save to memory",
		description:
			"Save something worth remembering about the user, so you know it in future conversations. " +
			"Use it on your own for durable facts and preferences, and always when the user asks you to remember something (\"remember…\", \"note that…\"). " +
			"Don't save one-off details, things only relevant to this conversation, or anything already in <winku_memory>.\n" +
			"kind:\n" +
			"- profile: a short lasting fact about the user (where they live, their job, family, tools, how they like answers). One line. It is in every conversation.\n" +
			"- goal: something they are working toward now (\"ship 0.2 by Friday\"). One line. It is in every conversation until it is done.\n" +
			"- note (default): a detail too specific for the profile, saved as a dated section in memory/<topic>.md. Notes come back when a later message relates to them.\n" +
			"To correct or drop a profile line or goal, set replaces to the existing line, with the new text as content (or empty content to drop it, e.g. a finished goal). " +
			"The user sees a \"Saved to memory\" note and can undo it.",
		parameters: Type.Object({
			kind: Type.Optional(Type.Union([Type.Literal("profile"), Type.Literal("goal"), Type.Literal("note")], { description: "Default note" })),
			title: Type.String({ description: 'Short title shown to the user, e.g. "Prefers oat milk"' }),
			content: Type.String({
				description: "The fact itself, written so it makes sense later without this conversation. For profile and goal one line; empty only to drop the line in replaces.",
			}),
			topic: Type.Optional(Type.String({ description: 'Notes only: topic file name, a short slug such as "food" or "project-atlas". Group related notes under one topic.' })),
			replaces: Type.Optional(Type.String({ description: "Profile and goal only: the existing line this corrects or drops, as it appears in <profile> or <goals>." })),
			important: Type.Optional(Type.Boolean({ description: "Notes only: worth bringing up more readily than other notes." })),
		}),
		async execute(_id, params) {
			const kind = params.kind ?? "note";
			let result: SaveResult;
			let where: string;
			if (kind === "note") {
				if (!params.topic?.trim()) throw new EngineError("A note needs a topic", "engine");
				result = store().save({ title: params.title, topic: params.topic, content: params.content, important: params.important }, sessionId());
				where = `memory/${result.slug}.md`;
			} else {
				const file = kind === "profile" ? "profile" : "goals";
				result = store().saveCore(file, { title: params.title, content: params.content, replaces: params.replaces }, sessionId());
				where = `memory/${CORE_FILES[file]}`;
			}
			onSaved(result);
			const details: MemorySaveDetails = { saveId: result.saveId, title: result.title, topic: result.slug };
			return {
				content: [{ type: "text", text: `Saved to memory: ${result.title} (${where}).` }],
				details,
			};
		},
	});
	const read = defineTool({
		name: "memory_read",
		label: "Read memory",
		description: "Read a memory topic file (memory/<topic>.md) in full, for when the notes recalled with a message or <note_topics> suggest it holds more.",
		parameters: Type.Object({
			topic: Type.String({ description: 'Topic slug, e.g. "food" for memory/food.md' }),
		}),
		async execute(_id, params) {
			return { content: [{ type: "text", text: store().read(params.topic) }], details: undefined };
		},
	});
	const find = defineTool({
		name: "memory_search",
		label: "Search memory",
		description:
			"Search your notes and past conversations' recaps by meaning and keyword. Related notes already come with each message as <recalled_memories>; " +
			"use this only to dig further, such as when the user refers to something from an earlier conversation that wasn't recalled.",
		parameters: Type.Object({
			query: Type.String({ description: "What to look for, in a few words" }),
		}),
		async execute(_id, params) {
			return { content: [{ type: "text", text: await search(params.query) }], details: undefined };
		},
	});
	return [save, read, find];
}
