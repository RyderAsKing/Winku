// Recall (SPEC §9): find the notes that relate to a message and add them to it.
//
// The notes live in memory\<topic>.md (memory.ts); this keeps a search index of them in
// engine\memory-index.sqlite that can be deleted at any time and is rebuilt from the files:
// FTS5 for keywords, and one bge-small vector per note (from the shell's `embed` Request) for
// meaning. A few thousand notes × 384 floats is a scan of a few milliseconds, so vectors are
// compared in plain TypeScript; no vector extension. Vectors are compared after taking away the
// model's common direction (recall-centre.ts), which spreads related and unrelated notes apart.
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MemoryStore, Note } from "./memory.ts";
import type { MemoryLink, RecallTrace } from "./protocol.ts";
import { PASSAGE_MEAN, QUERY_MEAN } from "./recall-centre.ts";

/** Sends texts to the shell's embedder. `query` adds bge's search instruction. Rejects when it can't. */
export type Embed = (texts: string[], query: boolean, timeoutMs: number) => Promise<Float32Array[]>;

export interface RecalledNote {
	id: string;
	topic: string;
	title: string;
	date: number;
	body: string;
	/** How close in meaning to the message (centred cosine, see recall-centre.ts), when vectors were compared. */
	similarity?: number;
}

/** Bump when the schema or what a row holds changes: the index is rebuilt from the files. */
const SCHEMA = "1";
const MODEL = "bge-small-en-v1.5";
const DIMS = 384;

// Similarities below are centred cosines (recall-centre.ts), tuned on test/fixtures/recall-eval.json:
// messages and notes embedded by the real model, with the notes each message should and shouldn't bring.

/** A note with no keyword in common with the message needs this much. */
export const MIN_SIMILARITY = 0.2;
/** A keyword match lowers the bar. */
export const MIN_SIMILARITY_WITH_KEYWORD = 0.12;
/** A note in a topic the message names ("my travel plans", topic travel) only needs not to be unrelated. */
export const MIN_SIMILARITY_IN_TOPIC = 0.0;
/** Once a note matches by keyword or topic as well as meaning, notes matching by meaning alone need more. */
export const MIN_SIMILARITY_BESIDE_KEYWORD = 0.3;
/** Notes much weaker than the best match are left out even when they clear the bar. */
const MAX_BEHIND_BEST = 0.3;
/** A named topic brings at most this many of its notes, newest first. */
const TOPIC_NOTES = 3;
/** memory_search is asked for on purpose, so it shows weaker matches too: any keyword hit, or this. */
export const MIN_SIMILARITY_SEARCH = 0.1;
/** The memory map links each note to its few closest notes in other topics, when they're at least this close. */
export const MAP_MIN_SIMILARITY = 0.3;
export const MAP_LINKS_PER_NOTE = 3;
/** At most this many notes per message, and about 600 tokens of them. */
/** How many left-out notes the message tester lists. */
const NEAR_MISSES = 6;
export const RECALL_LIMIT = 4;
export const RECALL_BUDGET_CHARS = 2400;
const NOTE_MAX_CHARS = 700;
/** How long a message waits for its query vector before going on with keywords alone. */
export const QUERY_TIMEOUT_MS = 350;
/** After the embedder says it isn't ready, don't ask again for this long. */
const EMBEDDER_RETRY_MS = 60_000;
const EMBED_BATCH = 8;

const STOPWORDS = new Set(
	(
		"a an and are as at be been but by can could did do does doing for from had has have having he her hers him his how i if in into is it its " +
		"just me my no not of on or our ours she should so some such than that the their them then there these they this those to too up us very " +
		"was we were what when where which who whom why will with would you your yours about again also am any because before being both each few " +
		"further here more most much now off once only other out over own same through under until while all get got let lets make made please " +
		"tell know think want like need see look say said thanks thank hi hello hey ok okay yes yeah one two"
	).split(" "),
);

/** Words worth searching for: letters and digits, two or more characters, not a stopword. */
export function keywords(text: string): string[] {
	const words = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
	return [...new Set(words.filter((w) => !STOPWORDS.has(w)))].slice(0, 16);
}

/** An FTS5 query matching any of the words (each quoted, so FTS syntax in the message is inert). */
export function ftsQuery(words: string[]): string {
	return words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" OR ");
}

/** `vec` minus `mean`, scaled back to length 1: a vector to compare by centred cosine. */
export function centre(vec: Float32Array, mean: Float32Array): Float32Array {
	const out = new Float32Array(vec.length);
	let norm = 0;
	for (let i = 0; i < vec.length; i++) {
		const v = (vec[i] ?? 0) - (mean[i] ?? 0);
		out[i] = v;
		norm += v * v;
	}
	norm = Math.sqrt(norm) || 1;
	for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / norm;
	return out;
}

function decodeMean(b64: string): Float32Array {
	const bytes = Buffer.from(b64, "base64");
	return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
export const PASSAGE_CENTRE = decodeMean(PASSAGE_MEAN);
export const QUERY_CENTRE = decodeMean(QUERY_MEAN);

export function dot(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += (a[i] as number) * (b[i] as number);
	return sum;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The block added to a user message, or "" for no notes. */
/** A note as recalled: its body already clipped by fit. */
function recalled(n: Note, similarity: number | undefined): RecalledNote {
	return { id: n.id, topic: n.topic, title: n.title, date: n.date, body: n.body, ...(similarity !== undefined ? { similarity } : {}) };
}

export function formatRecalled(notes: RecalledNote[]): string {
	if (!notes.length) return "";
	const parts = notes.map((n) => {
		const date = new Date(n.date).toISOString().slice(0, 10);
		return `<note id="${n.id}" topic="${escapeAttr(n.topic)}" date="${date}">\n${n.title}\n${n.body}\n</note>`;
	});
	return `\n\n<recalled_memories>\n${parts.join("\n")}\n</recalled_memories>`;
}

const TRAILING_RECALLED = /\n\n<recalled_memories>\n[\s\S]*\n<\/recalled_memories>$/;

/** A stored user message without its recalled block (the now line already split off). */
export function stripRecalled(text: string): string {
	return text.replace(TRAILING_RECALLED, "");
}

/** Ids of the notes recalled in a stored user message. */
export function recalledIds(text: string): string[] {
	const block = /\n\n<recalled_memories>\n([\s\S]*?)\n<\/recalled_memories>/.exec(text)?.[1];
	if (!block) return [];
	return [...block.matchAll(/<note id="([0-9a-f]+)"/g)].map((m) => m[1] as string);
}

interface Candidate {
	note: Note;
	ftsRank?: number;
	vecRank?: number;
	similarity?: number;
	keywordHits: number;
	/** The message names this note's topic. */
	inTopic?: boolean;
}

/**
 * Rank candidates: reciprocal-rank fusion of the keyword and vector lists, then a boost for
 * recent notes and ones marked important. Drops what doesn't clear the similarity bar.
 */
/**
 * Why a candidate is left out, or undefined when it passes. With vectors a note needs enough
 * similarity (a little less when it also matches a keyword) and to be near the best match; with
 * keywords alone it needs more than one stray word.
 */
export function gate(c: Candidate, best: number, haveVectors: boolean, words: number, loose = false, besideKeyword = false): string | undefined {
	if (loose) return c.ftsRank !== undefined || c.inTopic || (c.similarity ?? -1) >= MIN_SIMILARITY_SEARCH ? undefined : "not close enough";
	if (haveVectors && c.similarity !== undefined) {
		const bar = c.inTopic ? MIN_SIMILARITY_IN_TOPIC : c.ftsRank !== undefined ? MIN_SIMILARITY_WITH_KEYWORD : besideKeyword ? MIN_SIMILARITY_BESIDE_KEYWORD : MIN_SIMILARITY;
		if (c.similarity < bar) return c.inTopic ? "unrelated, though in the topic named" : `similarity under ${bar}`;
		if (!c.inTopic && c.similarity < best - MAX_BEHIND_BEST) return "much weaker than the best match";
		return undefined;
	}
	// Keywords alone (no embedder yet, or a note not embedded yet): ask for more than one stray word.
	if (c.inTopic) return undefined;
	if (c.ftsRank === undefined) return "no keyword match";
	return c.keywordHits >= Math.min(2, words) ? undefined : "only one word matched";
}

/** Whether every word of a topic's name ("travel", "home-office") is among the message's keywords, singular or plural. */
export function namesTopic(words: readonly string[], topic: string): boolean {
	const said = new Set(words.flatMap((w) => [w, w.replace(/s$/, ""), `${w}s`]));
	const parts = topic.split("-").filter(Boolean);
	return parts.length > 0 && parts.every((p) => said.has(p) || said.has(p.replace(/s$/, "")));
}

/** Whether some note matches by keyword or topic and also by meaning: then meaning alone needs more. */
function anchored(candidates: Candidate[], haveVectors: boolean): boolean {
	return haveVectors && candidates.some((c) => c.similarity !== undefined && (c.inTopic ? c.similarity >= MIN_SIMILARITY_WITH_KEYWORD : c.ftsRank !== undefined && c.similarity >= MIN_SIMILARITY_WITH_KEYWORD));
}

export function rank(candidates: Candidate[], now: number, haveVectors: boolean, words: number, loose = false): Candidate[] {
	const best = Math.max(-1, ...candidates.map((c) => c.similarity ?? -1));
	const beside = anchored(candidates, haveVectors);
	const kept = candidates.filter((c) => gate(c, best, haveVectors, words, loose, beside) === undefined);
	return kept.sort((a, b) => score(b, now) - score(a, now));
}

/** Rank fusion of the keyword and vector positions, lifted a little for recent and important notes. */
function score(c: Candidate, now: number): number {
	let rrf = 0;
	if (c.inTopic) rrf += 1 / 60;
	if (c.ftsRank !== undefined) rrf += 1 / (60 + c.ftsRank);
	if (c.vecRank !== undefined) rrf += 1 / (60 + c.vecRank);
	const ageDays = Math.max(0, (now - c.note.date) / 86_400_000);
	const recency = 1 + 0.3 * 0.5 ** (ageDays / 60);
	return rrf * recency * (c.note.important ? 1.3 : 1);
}

export function fit(notes: Note[], limit = RECALL_LIMIT, budget = RECALL_BUDGET_CHARS): Note[] {
	return fitExplained(notes, limit, budget).flatMap((r) => (r.reason ? [] : [r.note]));
}

/** fit, keeping the notes that didn't fit with why: past the note limit or over the size budget. */
export function fitExplained(notes: Note[], limit = RECALL_LIMIT, budget = RECALL_BUDGET_CHARS): { note: Note; reason?: string }[] {
	const out: { note: Note; reason?: string }[] = [];
	let used = 0;
	let count = 0;
	for (const note of notes) {
		if (count >= limit) {
			out.push({ note, reason: `past the limit of ${limit} notes` });
			continue;
		}
		const body = clip(note.body, NOTE_MAX_CHARS);
		const size = note.title.length + body.length + 60;
		if (used + size > budget) {
			out.push({ note, reason: `over the ${budget}-character budget` });
			continue;
		}
		used += size;
		count++;
		out.push({ note: { ...note, body } });
	}
	return out;
}

export class RecallIndex {
	private db: Database | undefined;
	private notes = new Map<string, Note>();
	/** Note vectors, centred (recall-centre.ts). The database keeps them as the model gave them. */
	private vectors = new Map<string, Float32Array>();
	private embedding: Promise<void> | undefined;
	private embedderDownUntil = 0;
	private stamp = "";

	constructor(
		private readonly store: MemoryStore,
		private readonly path: string,
		private embed: Embed | undefined,
		private readonly now: () => number = Date.now,
	) {}

	static pathFor(dataDir: string): string {
		return join(dataDir, "engine", "memory-index.sqlite");
	}

	setEmbed(embed: Embed | undefined): void {
		this.embed = embed;
	}

	private open(): Database {
		if (this.db) return this.db;
		mkdirSync(join(this.path, ".."), { recursive: true });
		try {
			this.db = this.create();
		} catch {
			// A damaged index is only a cache: start over from the files.
			this.dropFile();
			this.db = this.create();
		}
		return this.db;
	}

	private create(): Database {
		const db = new Database(this.path, { create: true });
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA synchronous = NORMAL");
		db.run("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
		const schema = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema'").get()?.value;
		if (schema !== SCHEMA) {
			db.run("DROP TABLE IF EXISTS notes");
			db.run("DROP TABLE IF EXISTS notes_fts");
			db.run("DROP TABLE IF EXISTS vectors");
			db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', ?)", [SCHEMA]);
		}
		db.run("CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, topic TEXT, title TEXT, date INTEGER, important INTEGER, body TEXT)");
		db.run("CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, title, body, topic, tokenize = 'porter unicode61 remove_diacritics 2')");
		db.run("CREATE TABLE IF NOT EXISTS vectors(id TEXT PRIMARY KEY, model TEXT, vec BLOB)");
		return db;
	}

	private dropFile(): void {
		try {
			this.db?.close();
		} catch {}
		this.db = undefined;
		for (const suffix of ["", "-wal", "-shm"]) rmSync(`${this.path}${suffix}`, { force: true });
	}

	/** Forget everything: the index goes with the files. */
	reset(): void {
		this.dropFile();
		this.notes.clear();
		this.vectors.clear();
		this.stamp = "";
	}

	close(): void {
		try {
			this.db?.close();
		} catch {}
		this.db = undefined;
	}

	/** Size and modification time of every topic file: cheap to compute, changes when any file does. */
	private fileStamp(): string {
		return this.store
			.topics()
			.map((topic) => {
				try {
					const s = statSync(join(this.store.dir, `${topic}.md`));
					return `${topic}:${s.size}:${s.mtimeMs}`;
				} catch {
					return topic;
				}
			})
			.join("|");
	}

	/** Bring the index up to date with the files if any changed. Returns whether it did anything. */
	sync(): boolean {
		const stamp = this.fileStamp();
		const db = this.open();
		if (stamp === this.stamp && this.notes.size === this.countRows(db)) return false;
		const fresh = new Map(this.store.notes().map((n) => [n.id, n]));
		const stored = new Set(db.query<{ id: string }, []>("SELECT id FROM notes").all().map((r) => r.id));
		const insert = db.query("INSERT OR REPLACE INTO notes(id, topic, title, date, important, body) VALUES (?, ?, ?, ?, ?, ?)");
		const insertFts = db.query("INSERT INTO notes_fts(id, title, body, topic) VALUES (?, ?, ?, ?)");
		const remove = db.query("DELETE FROM notes WHERE id = ?");
		const removeFts = db.query("DELETE FROM notes_fts WHERE id = ?");
		const removeVec = db.query("DELETE FROM vectors WHERE id = ?");
		db.transaction(() => {
			for (const id of stored) {
				if (fresh.has(id)) continue;
				remove.run(id);
				removeFts.run(id);
				removeVec.run(id);
			}
			for (const note of fresh.values()) {
				if (stored.has(note.id)) continue;
				insert.run(note.id, note.topic, note.title, note.date, note.important ? 1 : 0, note.body);
				insertFts.run(note.id, note.title, note.body, note.topic.replace(/-/g, " "));
			}
		})();
		this.notes = fresh;
		this.vectors.clear();
		for (const row of db.query<{ id: string; vec: Uint8Array }, [string]>("SELECT id, vec FROM vectors WHERE model = ?").all(MODEL)) {
			if (row.vec.byteLength !== DIMS * 4 || !fresh.has(row.id)) continue;
			this.vectors.set(row.id, centre(new Float32Array(row.vec.buffer.slice(row.vec.byteOffset, row.vec.byteOffset + row.vec.byteLength)), PASSAGE_CENTRE));
		}
		this.stamp = stamp;
		return true;
	}

	/**
	 * Pairs of notes in different topics that mean similar things, for the memory map: each note keeps
	 * its closest few at or above `min`. Same-topic notes are already joined through their topic.
	 * Notes without a vector have no links.
	 */
	links(perNote = MAP_LINKS_PER_NOTE, min = MAP_MIN_SIMILARITY): MemoryLink[] {
		this.sync();
		const entries = [...this.vectors].flatMap(([id, vec]) => {
			const note = this.notes.get(id);
			return note ? [{ id, topic: note.topic, vec }] : [];
		});
		const pairs = new Map<string, MemoryLink>();
		for (const a of entries) {
			const closest: { id: string; similarity: number }[] = [];
			for (const b of entries) {
				if (a.topic === b.topic) continue;
				const similarity = dot(a.vec, b.vec);
				if (similarity >= min) closest.push({ id: b.id, similarity });
			}
			closest.sort((x, y) => y.similarity - x.similarity);
			for (const { id, similarity } of closest.slice(0, perNote)) {
				const [first, second] = a.id < id ? [a.id, id] : [id, a.id];
				pairs.set(`${first} ${second}`, { a: first, b: second, similarity: Math.round(similarity * 1000) / 1000 });
			}
		}
		return [...pairs.values()].sort((x, y) => y.similarity - x.similarity);
	}

	private countRows(db: Database): number {
		return db.query<{ n: number }, []>("SELECT count(*) AS n FROM notes").get()?.n ?? 0;
	}

	stats(): { notes: number; embedded: number } {
		this.sync();
		return { notes: this.notes.size, embedded: this.vectors.size };
	}

	private embedderReady(): boolean {
		return !!this.embed && this.now() >= this.embedderDownUntil;
	}

	private embedderFailed(error: unknown): void {
		// Not installed yet (the shell starts the download), recall off, or an older shell.
		this.embedderDownUntil = this.now() + EMBEDDER_RETRY_MS;
		if (!/embedder_not_ready|recall_off|unknown request method|did not answer/.test(String(error))) {
			process.stderr.write(`memory: embedding failed: ${String(error)}\n`);
		}
	}

	/** Embed the notes that have no vector yet, a few at a time, in the background. */
	embedPending(): Promise<void> {
		if (this.embedding) return this.embedding;
		const run = async () => {
			while (this.embedderReady()) {
				const batch = [...this.notes.values()].filter((n) => !this.vectors.has(n.id)).slice(0, EMBED_BATCH);
				if (!batch.length || !this.embed) return;
				let vectors: Float32Array[];
				try {
					vectors = await this.embed(
						batch.map((n) => `${n.title}\n${n.body}`.slice(0, 2000)),
						false,
						30_000,
					);
				} catch (error) {
					this.embedderFailed(error);
					return;
				}
				const db = this.open();
				const put = db.query("INSERT OR REPLACE INTO vectors(id, model, vec) VALUES (?, ?, ?)");
				db.transaction(() => {
					batch.forEach((note, i) => {
						const vec = vectors[i];
						if (!vec || vec.length !== DIMS || !this.notes.has(note.id)) return;
						put.run(note.id, MODEL, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
						this.vectors.set(note.id, centre(vec, PASSAGE_CENTRE));
					});
				})();
				if (vectors.length < batch.length) return;
			}
		};
		this.embedding = run().finally(() => {
			this.embedding = undefined;
		});
		return this.embedding;
	}

	/** Bring the index up to date and embed new notes in the background, so the next search has vectors. */
	warm(): void {
		try {
			this.sync();
			void this.embedPending();
		} catch (error) {
			process.stderr.write(`memory: index sync failed: ${String(error)}\n`);
		}
	}

	/** Wait for background embedding to finish (tests, shutdown). */
	async settled(): Promise<void> {
		while (this.embedding) await this.embedding;
	}

	/**
	 * The notes that relate to `text`, best first, within the recall limit and budget. `exclude`
	 * holds ids already in the model's context. Never throws: recall is a bonus, not a gate.
	 */
	async search(text: string, options: { exclude?: ReadonlySet<string>; limit?: number; budget?: number; timeoutMs?: number; loose?: boolean } = {}): Promise<RecalledNote[]> {
		const found = await this.gather(text, options.timeoutMs ?? QUERY_TIMEOUT_MS);
		if (!found) return [];
		const exclude = options.exclude ?? new Set<string>();
		const ranked = rank(found.candidates, this.now(), found.byMeaning, found.words, options.loose).filter((c) => !exclude.has(c.note.id));
		const similarity = new Map(ranked.map((c) => [c.note.id, c.similarity]));
		return fit(
			ranked.map((c) => c.note),
			options.limit,
			options.budget,
		).map((n) => recalled(n, similarity.get(n.id)));
	}

	/**
	 * The search a message would get (Settings > Try a message): what would be sent, and the notes
	 * that came close with why they were left out. Same limits and timeout as a real message.
	 */
	async explain(text: string, exclude: ReadonlySet<string> = new Set()): Promise<RecallTrace> {
		const started = performance.now();
		const found = await this.gather(text, QUERY_TIMEOUT_MS);
		const ms = Math.round(performance.now() - started);
		if (!found) return { byMeaning: false, why: this.notes.size ? undefined : "no notes", ms, sent: [], considered: [] };
		const best = Math.max(-1, ...found.candidates.map((c) => c.similarity ?? -1));
		const beside = anchored(found.candidates, found.byMeaning);
		const reasons = new Map<string, string>();
		for (const c of found.candidates) {
			const reason = exclude.has(c.note.id) ? "already sent earlier in this conversation" : gate(c, best, found.byMeaning, found.words, false, beside);
			if (reason) reasons.set(c.note.id, reason);
		}
		const passing = rank(found.candidates, this.now(), found.byMeaning, found.words).filter((c) => !reasons.has(c.note.id));
		const fitted = fitExplained(passing.map((c) => c.note));
		for (const r of fitted) if (r.reason) reasons.set(r.note.id, r.reason);
		const byId = new Map(found.candidates.map((c) => [c.note.id, c]));
		const sent = fitted.flatMap((r) => (r.reason ? [] : [recalled(r.note, byId.get(r.note.id)?.similarity)]));
		// Left out: only the near misses, a keyword match or as close as memory_search would accept.
		const near = (c: Candidate) => c.ftsRank !== undefined || c.inTopic || (c.similarity ?? -1) >= MIN_SIMILARITY_SEARCH;
		const left = found.candidates
			.filter((c) => reasons.has(c.note.id) && near(c))
			.sort((x, y) => (y.similarity ?? -1) - (x.similarity ?? -1) || (x.ftsRank ?? 99) - (y.ftsRank ?? 99))
			.slice(0, NEAR_MISSES);
		return {
			byMeaning: found.byMeaning,
			why: found.why,
			ms,
			sent,
			considered: [...sent.map((n) => byId.get(n.id) as Candidate), ...left].map((c) => ({
				id: c.note.id,
				topic: c.note.topic,
				title: c.note.title,
				...(c.similarity !== undefined ? { similarity: Math.round(c.similarity * 1000) / 1000 } : {}),
				keyword: c.ftsRank !== undefined,
				...(c.inTopic ? { namedTopic: true } : {}),
				...(reasons.has(c.note.id) ? { reason: reasons.get(c.note.id) } : {}),
			})),
		};
	}

	/**
	 * Every note that matches the text by keyword (FTS5) or is among the 20 closest by meaning, and
	 * whether meaning was used at all: without it, `why` says what stopped it. Undefined when there is
	 * nothing to search.
	 */
	private async gather(text: string, timeoutMs: number): Promise<{ candidates: Candidate[]; words: number; byMeaning: boolean; why?: string } | undefined> {
		try {
			this.sync();
		} catch (error) {
			process.stderr.write(`memory: index sync failed: ${String(error)}\n`);
			return undefined;
		}
		if (!this.notes.size || !text.trim()) return undefined;
		void this.embedPending();
		const words = keywords(text);
		// Small talk ("hello there", "ok thanks") has nothing to look up, and meaning alone would find something anyway.
		if (!words.length) return { candidates: [], words: 0, byMeaning: false, why: "the message has no words worth searching for" };
		const candidates = new Map<string, Candidate>();
		const candidate = (note: Note): Candidate => {
			let c = candidates.get(note.id);
			if (!c) {
				const hay = `${note.title}\n${note.body}\n${note.topic}`.toLowerCase();
				c = { note, keywordHits: words.filter((w) => hay.includes(w)).length };
				candidates.set(note.id, c);
			}
			return c;
		};
		// A message that names a topic ("my travel plans") brings that topic's newest notes along.
		for (const topic of new Set([...this.notes.values()].map((n) => n.topic))) {
			if (!namesTopic(words, topic)) continue;
			const newest = [...this.notes.values()].filter((n) => n.topic === topic).sort((a, b) => b.date - a.date);
			for (const note of newest.slice(0, TOPIC_NOTES)) candidate(note).inTopic = true;
		}
		if (words.length) {
			const db = this.open();
			const rows = db
				.query<{ id: string }, [string]>("SELECT id FROM notes_fts WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts, 2.0, 1.0, 0.5) LIMIT 20")
				.all(ftsQuery(words));
			rows.forEach((row, i) => {
				const note = this.notes.get(row.id);
				if (note) candidate(note).ftsRank = i;
			});
		}
		let query: Float32Array | undefined;
		let why: string | undefined;
		// Also when the first notes are still being embedded: they go first and are likely in by the time the query is.
		if (!this.embed) why = "no search model";
		else if (!this.vectors.size && !this.embedding) why = "no note has a vector yet";
		else if (!this.embedderReady()) why = "the search model failed a moment ago";
		else {
			try {
				const raw = (await this.embed([text.slice(0, 2000)], true, timeoutMs))[0];
				query = raw?.length === DIMS ? centre(raw, QUERY_CENTRE) : raw;
			} catch (error) {
				// A slow answer only skips meaning for this message; anything else waits a minute.
				if (/did not answer/.test(String(error))) why = `the search model didn't answer within ${timeoutMs} ms`;
				else {
					this.embedderFailed(error);
					why = "the search model failed";
				}
			}
		}
		if (query?.length === DIMS) {
			const scored: { id: string; similarity: number }[] = [];
			for (const [id, vec] of this.vectors) scored.push({ id, similarity: dot(query, vec) });
			scored.sort((a, b) => b.similarity - a.similarity);
			scored.slice(0, 20).forEach((s, i) => {
				const note = this.notes.get(s.id);
				if (!note) return;
				const c = candidate(note);
				c.vecRank = i;
				c.similarity = s.similarity;
			});
			// Keyword hits outside the vector top 20 still need a similarity to be judged.
			for (const c of candidates.values()) {
				if (c.similarity !== undefined) continue;
				const vec = this.vectors.get(c.note.id);
				if (vec) c.similarity = dot(query, vec);
			}
		} else if (query && !why) why = "the search model sent a vector of the wrong size";
		return { candidates: [...candidates.values()], words: words.length, byMeaning: query?.length === DIMS, ...(why ? { why } : {}) };
	}
}
