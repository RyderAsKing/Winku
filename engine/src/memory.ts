// Memory (SPEC §9): memory\MEMORY.md index + memory\<topic>.md detail files, the starter files,
// save / read / undo / forget-all, and the memory_save / memory_read tools.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { EngineError } from "./runtime.ts";

/** About this many index lines are kept; the oldest drop off (their topic files stay). */
export const INDEX_MAX_LINES = 150;
const INDEX_FILE = "MEMORY.md";

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
	if (!slug || slug === "memory") throw new EngineError(`Invalid memory topic "${topic}"`, "engine");
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

export function dateSection(title: string, content: string, date: Date): string {
	return `## ${date.toISOString().slice(0, 10)}: ${oneLine(title, 80)}\n\n${content.trim()}\n`;
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

	save(input: { title: string; topic: string; content: string }, sessionId: string): SaveResult {
		const title = oneLine(input.title, 80);
		if (!title) throw new EngineError("A memory needs a title", "engine");
		if (!input.content.trim()) throw new EngineError("A memory needs content", "engine");
		const slug = topicSlug(input.topic);
		mkdirSync(this.dir, { recursive: true });
		const topicPath = join(this.dir, `${slug}.md`);
		const indexBefore = this.index();
		const topicBefore = readOrNull(topicPath);
		const section = dateSection(title, input.content, this.now());
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
		const save = lines.find((l) => l.type === "save" && l.saveId === saveId);
		if (!save || save.type !== "save") throw new EngineError("Nothing to undo", "engine");
		if (lines.some((l) => l.type === "undone" && l.saveId === saveId)) throw new EngineError("Already undone", "engine");
		if (save.sessionId !== sessionId) throw new EngineError("That memory was saved in another thread", "engine");
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

export function memoryTools(store: () => MemoryStore, sessionId: () => string, onSaved: (save: SaveResult) => void) {
	const save = defineTool({
		name: "memory_save",
		label: "Save to memory",
		description:
			"Save something worth remembering about the user to long-term memory, so you know it in future conversations. " +
			"Use it on your own for durable facts and preferences (people, projects, tools, how they like things done), " +
			'and always when the user asks you to remember something ("remember…", "note that…"). ' +
			"Don't save one-off details, things only relevant to this conversation, or anything already in memory. " +
			"Each save appends a dated section to memory/<topic>.md and adds or updates one line in the memory index. " +
			"Group related things under one short topic (e.g. family, work, coffee). The user sees a \"Saved to memory\" note and can undo it.",
		parameters: Type.Object({
			title: Type.String({ description: "Short title shown to the user, e.g. \"Prefers oat milk\"" }),
			topic: Type.String({ description: "Topic file name: a short slug such as \"food\" or \"project-atlas\"" }),
			content: Type.String({ description: "The fact itself, written so it makes sense later without this conversation. The first line becomes the index hook." }),
		}),
		async execute(_id, params) {
			const result = store().save(params, sessionId());
			onSaved(result);
			const details: MemorySaveDetails = { saveId: result.saveId, title: result.title, topic: result.slug };
			return {
				content: [{ type: "text", text: `Saved to memory: ${result.title} (memory/${result.slug}.md).` }],
				details,
			};
		},
	});
	const read = defineTool({
		name: "memory_read",
		label: "Read memory",
		description:
			"Read a memory topic file (memory/<topic>.md) in full. The memory index in your instructions lists one line per topic; " +
			"read the file when that line suggests it holds details relevant to the request.",
		parameters: Type.Object({
			topic: Type.String({ description: 'Topic slug from the index, e.g. "food" for (food.md)' }),
		}),
		async execute(_id, params) {
			return { content: [{ type: "text", text: store().read(params.topic) }], details: undefined };
		},
	});
	return [save, read];
}
