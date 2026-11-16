// Tidy (SPEC §9): a background pass over the conversation since the last one, on the Quick
// actions model, that keeps the profile and goals current, adds notes worth keeping and writes a
// recap of the thread. It runs after a clear, after a quiet spell, or from Settings, and never
// sits in the path of a reply.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type CoreKind, coreFile, coreLines, editCoreLines, type MemoryStore, recapFile, THREADS_TOPIC } from "./memory.ts";
import { stripMood } from "./mood.ts";
import { parseNow } from "./nowline.ts";
import type { ThinkingLevel } from "./protocol.ts";
import { stripRecalled } from "./recall.ts";
import { splitSay } from "./say.ts";
import { textOf, toolSummary } from "./thread.ts";

/** About 6k tokens of conversation per pass; longer stretches keep their end. */
export const CONVERSATION_BUDGET = 24_000;
/** A quiet spell this long after a reply starts a tidy. */
export const IDLE_DELAY_MS = 10 * 60_000;
/** Less new user text than this isn't worth a model call ("thanks", "hi"). */
export const MIN_USER_CHARS = 40;
/** The recent notes shown to the model, so it doesn't add them again. */
const RECENT_NOTES = 60;

export interface TidyModel {
	runtime: ModelRuntime;
	model: Model<Api>;
	thinking: ThinkingLevel;
}

/** One line of engine\memory-tidy.jsonl: what a pass changed, so a bad one can be traced and fixed by hand. */
interface TidyLog {
	at: number;
	sessionId: string;
	reason: TidyReason;
	profile?: { before: string; after: string };
	goals?: { before: string; after: string };
	notes?: { topic: string; title: string }[];
	recap?: string;
}

export type TidyReason = "clear" | "idle" | "manual";

interface TidyState {
	/** Per thread: the last entry a pass has read. */
	threads: Record<string, { through: string; at: number }>;
	lastTidy: number | null;
}

/** What the model returns. Line numbers refer to the numbered lists it was shown. */
export interface TidyPlan {
	profile: LineOp[];
	goals: LineOp[];
	notes: { topic: string; title: string; content: string }[];
	recap: { title: string; summary: string } | null;
}

type LineOp = { op: "add"; text: string } | { op: "replace"; line: number; text: string } | { op: "remove"; line: number };

// ───────────────────────────── pure parts ─────────────────────────────

/**
 * The conversation after entry `through` as plain lines for the model, within the budget (the
 * end is kept), plus the last entry's id and how much the user wrote.
 */
export function conversationText(
	entries: SessionEntry[],
	through: string | undefined,
	budget = CONVERSATION_BUDGET,
): { text: string; lastId: string | undefined; userChars: number } {
	let start = 0;
	if (through) {
		const at = entries.findIndex((e) => e.id === through);
		if (at >= 0) start = at + 1;
	}
	const lines: string[] = [];
	let userChars = 0;
	let lastId: string | undefined = through;
	for (const entry of entries.slice(start)) {
		lastId = entry.id;
		if (entry.type !== "message") continue;
		const message = entry.message as { role: string; content?: unknown };
		if (message.role === "user") {
			const text = stripRecalled(parseNow(textOf(message.content)).text).trim();
			if (!text) continue;
			userChars += text.length;
			lines.push(`User: ${text}`);
		} else if (message.role === "assistant") {
			const blocks = (Array.isArray(message.content) ? message.content : []) as { type: string; name?: string; arguments?: unknown }[];
			const split = splitSay(stripMood(textOf(blocks)).text);
			const text = (split.text.trim() || split.said.join(" ")).trim();
			if (text) lines.push(`Assistant: ${text}`);
			for (const block of blocks) {
				if (block.type !== "toolCall" || !block.name) continue;
				if (block.name === "memory_save") {
					const a = (block.arguments ?? {}) as Record<string, unknown>;
					lines.push(`[saved to memory as ${String(a.kind ?? "note")}: ${String(a.title ?? "")}: ${String(a.content ?? "")}]`);
				} else {
					lines.push(`[used ${block.name}: ${toolSummary(block.name, block.arguments)}]`);
				}
			}
		}
	}
	let text = lines.join("\n\n");
	if (text.length > budget) text = `(earlier part left out)\n…${text.slice(-budget)}`;
	return { text, lastId, userChars };
}

const SYSTEM = `You keep the long-term memory of Winku, a small desktop assistant, about its user. You read a conversation between them and update that memory. Reply with one JSON object and nothing else: no prose and no code fence.`;

function numbered(lines: string[]): string {
	return lines.length ? lines.map((l, i) => `${i + 1}. ${l}`).join("\n") : "(empty)";
}

export function tidyPrompt(input: {
	profile: string[];
	goals: string[];
	recentNotes: string[];
	conversation: string;
	date: string;
}): string {
	return `<profile>
${numbered(input.profile)}
</profile>

<goals>
${numbered(input.goals)}
</goals>

<recent_notes>
${input.recentNotes.length ? input.recentNotes.join("\n") : "(none)"}
</recent_notes>

<conversation date="${input.date}">
${input.conversation}
</conversation>

Update the memory from the conversation.

- profile: short lasting facts about the user, one per line, in the third person without their name ("Lives in Berlin", "Prefers metric units", "Works on Winku, a desktop assistant"). Add what is new and lasting. Replace a line the conversation shows is out of date, and remove one it contradicts. Never repeat a line. Keep the whole profile under 2,000 characters, merging or dropping the least useful lines if it would grow past that.
- goals: what the user is working toward now, one per line, with the deadline if there is one. Add new ones, reword changed ones, and remove ones that are done or dropped. At most 10.
- notes: details worth keeping that are too specific for the profile: decisions, a project's specifics, people and how they relate to the user, preferences in a narrow area. Skip what is already in recent_notes or was saved during the conversation ([saved to memory …]). Each note has a short topic slug (reuse a topic from recent_notes when it fits), a title of a few words and the content as one or two sentences that make sense later on their own. At most 5.
- recap: what the conversation was about and where it was left, in two to four sentences for the assistant to read at the start of the next conversation, with a title of a few words. null if the conversation was only small talk.

Only record what the user said or clearly confirmed, not the assistant's guesses or suggestions. Never record passwords, keys, card numbers or other secrets. Use empty arrays where nothing changes.

Reply in exactly this shape, with line numbers from the numbered lists above:
{"profile":[{"op":"add","text":"…"},{"op":"replace","line":2,"text":"…"},{"op":"remove","line":3}],"goals":[],"notes":[{"topic":"…","title":"…","content":"…"}],"recap":{"title":"…","summary":"…"}}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

function lineOps(value: unknown): LineOp[] {
	if (!Array.isArray(value)) return [];
	const ops: LineOp[] = [];
	for (const raw of value) {
		if (!isObject(raw)) continue;
		const text = typeof raw.text === "string" ? raw.text.trim() : "";
		const line = typeof raw.line === "number" && Number.isInteger(raw.line) ? raw.line : undefined;
		if (raw.op === "add" && text) ops.push({ op: "add", text });
		else if (raw.op === "replace" && line !== undefined && text) ops.push({ op: "replace", line, text });
		else if (raw.op === "remove" && line !== undefined) ops.push({ op: "remove", line });
	}
	return ops;
}

/** The model's reply as a plan; anything malformed is dropped. Throws when there is no JSON object. */
export function parsePlan(reply: string): TidyPlan {
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("The tidy reply had no JSON");
	const data = JSON.parse(reply.slice(start, end + 1)) as unknown;
	if (!isObject(data)) throw new Error("The tidy reply wasn't an object");
	const notes = (Array.isArray(data.notes) ? data.notes : [])
		.filter(isObject)
		.map((n) => ({
			topic: typeof n.topic === "string" ? n.topic : "",
			title: typeof n.title === "string" ? n.title : "",
			content: typeof n.content === "string" ? n.content : "",
		}))
		.filter((n) => n.topic.trim() && n.title.trim() && n.content.trim())
		.slice(0, 5);
	const recap =
		isObject(data.recap) && typeof data.recap.summary === "string" && data.recap.summary.trim()
			? { title: typeof data.recap.title === "string" && data.recap.title.trim() ? data.recap.title.trim() : "Conversation", summary: data.recap.summary.trim() }
			: null;
	return { profile: lineOps(data.profile), goals: lineOps(data.goals), notes, recap };
}

/**
 * Apply line ops to `current`. Ops refer to `shown` (what the model saw), and are applied by text,
 * so a memory_save that landed while the model was thinking isn't undone.
 */
export function applyOps(shown: string[], current: string[], ops: LineOp[]): string[] {
	let lines = [...current];
	const target = (n: number) => shown[n - 1];
	for (const op of ops) {
		try {
			if (op.op === "add") lines = editCoreLines(lines, op.text, undefined).lines;
			else {
				const original = target(op.line);
				if (original === undefined) continue;
				lines = editCoreLines(lines, op.op === "replace" ? op.text : "", original).lines;
			}
		} catch {
			// The line is gone already, or the op was empty: skip it.
		}
	}
	return lines;
}

// ───────────────────────────── runner ─────────────────────────────

export class Tidy {
	private readonly statePath: string;
	private readonly logPath: string;
	private chain: Promise<unknown> = Promise.resolve();
	private pending = 0;

	constructor(
		dataDir: string,
		private readonly store: () => MemoryStore,
		private readonly now: () => Date = () => new Date(),
	) {
		this.statePath = join(dataDir, "engine", "memory-tidy.json");
		this.logPath = join(dataDir, "engine", "memory-tidy.jsonl");
	}

	get running(): boolean {
		return this.pending > 0;
	}

	get lastTidy(): number | null {
		return this.readState().lastTidy;
	}

	private readState(): TidyState {
		try {
			const data = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<TidyState>;
			return { threads: isObject(data.threads) ? (data.threads as TidyState["threads"]) : {}, lastTidy: typeof data.lastTidy === "number" ? data.lastTidy : null };
		} catch {
			return { threads: {}, lastTidy: null };
		}
	}

	private writeState(state: TidyState): void {
		mkdirSync(join(this.statePath, ".."), { recursive: true });
		const tmp = `${this.statePath}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(state)}\n`);
		renameSync(tmp, this.statePath);
	}

	/** How much the user has written in a thread since its last pass. */
	newUserChars(sessionId: string, entries: SessionEntry[]): number {
		return conversationText(entries, this.readState().threads[sessionId]?.through, Number.POSITIVE_INFINITY).userChars;
	}

	/** Forget everything: what was read goes with what was learned. */
	reset(): void {
		this.writeState({ threads: {}, lastTidy: null });
	}

	/** Queue a pass; passes run one at a time. Resolves with whether memory changed. */
	run(
		target: { sessionId: string; entries: () => SessionEntry[] },
		reason: TidyReason,
		model: () => TidyModel,
		options: { force?: boolean } = {},
	): Promise<boolean> {
		this.pending++;
		const next = this.chain.then(() => this.pass(target, reason, model(), options.force === true));
		this.chain = next.catch(() => {});
		return next.finally(() => {
			this.pending--;
		});
	}

	private async pass(target: { sessionId: string; entries: () => SessionEntry[] }, reason: TidyReason, setup: TidyModel, force: boolean): Promise<boolean> {
		const state = this.readState();
		const through = state.threads[target.sessionId]?.through;
		const conversation = conversationText(target.entries(), through);
		if (!conversation.lastId || conversation.lastId === through) return false;
		const markRead = () => {
			const latest = this.readState();
			latest.threads[target.sessionId] = { through: conversation.lastId as string, at: this.now().getTime() };
			latest.lastTidy = this.now().getTime();
			this.writeState(latest);
		};
		if (conversation.userChars < (force ? 1 : MIN_USER_CHARS)) {
			markRead();
			return false;
		}
		const store = this.store();
		const shownProfile = coreLines(store.core("profile"));
		const shownGoals = coreLines(store.core("goals"));
		const recentNotes = store
			.notes()
			.filter((n) => n.topic !== THREADS_TOPIC)
			.sort((a, b) => b.date - a.date)
			.slice(0, RECENT_NOTES)
			.map((n) => `- ${n.topic}: ${n.title}`);
		const request: Context = {
			systemPrompt: SYSTEM,
			messages: [
				{
					role: "user",
					content: tidyPrompt({
						profile: shownProfile,
						goals: shownGoals,
						recentNotes,
						conversation: conversation.text,
						date: this.now().toISOString().slice(0, 10),
					}),
					timestamp: Date.now(),
				},
			],
		};
		const stream = setup.runtime.streamSimple(setup.model, request, {
			sessionId: `tidy-${target.sessionId}`,
			...(setup.thinking !== "off" ? { reasoning: setup.thinking } : {}),
		});
		let text = "";
		for await (const event of stream) if (event.type === "text_delta") text += event.delta;
		const message = await stream.result();
		if (message.stopReason === "error") throw new Error(message.errorMessage ?? "The model returned an error");
		if (!text.trim()) text = textOf(message.content);
		const plan = parsePlan(text);

		const log: TidyLog = { at: this.now().getTime(), sessionId: target.sessionId, reason };
		let changed = false;
		const updateCore = (kind: Exclude<CoreKind, "recap">, shown: string[], ops: LineOp[]) => {
			if (!ops.length) return;
			const before = store.core(kind);
			const after = coreFile(kind, applyOps(shown, coreLines(before), ops));
			if (after === before || (!after && !before.trim())) return;
			store.setCore(kind, after);
			log[kind] = { before, after };
			changed = true;
		};
		updateCore("profile", shownProfile, plan.profile);
		updateCore("goals", shownGoals, plan.goals);
		const added: { topic: string; title: string }[] = [];
		for (const note of plan.notes) {
			try {
				added.push({ topic: store.addNote(note), title: note.title });
			} catch {
				// A bad topic name: skip that note.
			}
		}
		if (added.length) {
			log.notes = added;
			changed = true;
		}
		if (plan.recap) {
			store.setCore("recap", recapFile(plan.recap.summary));
			store.saveThreadRecap(target.sessionId, plan.recap.title, plan.recap.summary, this.now());
			log.recap = plan.recap.summary;
			changed = true;
		}
		markRead();
		if (changed) {
			mkdirSync(join(this.logPath, ".."), { recursive: true });
			appendFileSync(this.logPath, `${JSON.stringify(log)}\n`);
		}
		return changed;
	}
}

