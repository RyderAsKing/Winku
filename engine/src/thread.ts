// The one persistent thread: which session file is current, clear/undo, history, transcripts.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { stripMood } from "./mood.ts";
import { splitSay } from "./say.ts";
import { parseNow } from "./nowline.ts";
import type { HistoryEntry, TranscriptItem } from "./protocol.ts";
import { classifyError, EngineError } from "./runtime.ts";

interface UndoState {
	token: string;
	archivedFile: string;
	newManager: SessionManager;
}

export class Thread {
	readonly engineDir: string;
	readonly sessionDir: string;
	private readonly pointerPath: string;
	private readonly actionsPath: string;
	manager: SessionManager;
	private undo: UndoState | undefined;
	/** saveIds of undone memory saves, for the transcript's memory_saved rows. */
	undoneSaves: () => ReadonlySet<string> = () => new Set();

	constructor(readonly dataDir: string) {
		this.engineDir = join(dataDir, "engine");
		this.sessionDir = join(this.engineDir, "sessions");
		this.pointerPath = join(this.engineDir, "current.json");
		this.actionsPath = join(this.engineDir, "actions.jsonl");
		mkdirSync(this.sessionDir, { recursive: true });
		const pointed = this.readPointer();
		this.manager = pointed && existsSync(pointed) ? this.open(pointed) : this.create();
		this.writePointer();
	}

	get sessionId(): string {
		return this.manager.getSessionId();
	}

	get sessionFile(): string | undefined {
		return this.manager.getSessionFile();
	}

	private open(path: string): SessionManager {
		return SessionManager.open(path, this.sessionDir, this.dataDir);
	}

	private create(): SessionManager {
		return SessionManager.create(this.dataDir, this.sessionDir);
	}

	private readPointer(): string | undefined {
		try {
			const data = JSON.parse(readFileSync(this.pointerPath, "utf8")) as { sessionFile?: unknown };
			return typeof data.sessionFile === "string" ? data.sessionFile : undefined;
		} catch {
			return undefined;
		}
	}

	private writePointer(): void {
		const tmp = `${this.pointerPath}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ sessionFile: this.manager.getSessionFile() ?? null })}\n`);
		renameSync(tmp, this.pointerPath);
	}

	private isEmpty(manager: SessionManager): boolean {
		return !manager.getEntries().some((e) => e.type === "message");
	}

	/** Archive the current thread (its file stays) and start a new one. */
	clear(): { undoToken: string } {
		const archivedFile = this.manager.getSessionFile();
		this.manager = this.create();
		this.writePointer();
		const token = randomUUID();
		this.undo = archivedFile ? { token, archivedFile, newManager: this.manager } : undefined;
		return { undoToken: token };
	}

	/** Drop the new thread if it is still empty and switch back to the archived one. */
	undoClear(token: string): void {
		const undo = this.undo;
		if (!undo || undo.token !== token) throw new EngineError("Nothing to undo", "engine");
		if (undo.newManager !== this.manager || !this.isEmpty(this.manager))
			throw new EngineError("The new thread already has messages", "engine");
		const file = this.manager.getSessionFile();
		if (file && existsSync(file)) rmSync(file);
		this.manager = this.open(undo.archivedFile);
		this.undo = undefined;
		this.writePointer();
	}

	/** Make a history entry the current thread. The current one stays as an archived file. */
	async restore(entryId: string): Promise<void> {
		const path = await this.findSession(entryId);
		if (!path) throw new EngineError(`No thread "${entryId}"`, "engine");
		if (path === this.manager.getSessionFile()) return;
		const previous = this.manager;
		this.manager = this.open(path);
		this.undo = undefined;
		this.writePointer();
		// A brand-new empty thread has nothing worth archiving.
		const previousFile = previous.getSessionFile();
		if (previousFile && this.isEmpty(previous) && existsSync(previousFile)) rmSync(previousFile);
	}

	private async findSession(id: string): Promise<string | undefined> {
		if (id === this.sessionId) return this.sessionFile;
		const sessions = await SessionManager.list(this.dataDir, this.sessionDir);
		return sessions.find((s) => s.id === id)?.path;
	}

	async list(query?: string): Promise<HistoryEntry[]> {
		const needle = query?.trim().toLowerCase();
		const currentFile = this.manager.getSessionFile();
		const sessions = await SessionManager.list(this.dataDir, this.sessionDir);
		const entries: HistoryEntry[] = [];
		for (const s of sessions) {
			const current = s.path === currentFile;
			if (s.messageCount === 0 && !current) continue;
			if (needle && !s.allMessagesText.toLowerCase().includes(needle)) continue;
			entries.push({
				id: s.id,
				kind: "thread",
				title: titleOf(parseNow(s.firstMessage).text),
				startedAt: s.created.getTime(),
				updatedAt: s.modified.getTime(),
				messageCount: countMessages(s.path),
				current,
			});
		}
		// The current thread may not be on disk yet (pi writes the file with the first reply).
		if (!needle && !entries.some((e) => e.current)) {
			const header = this.manager.getHeader();
			const startedAt = header ? Date.parse(header.timestamp) : Date.now();
			entries.push({
				id: this.sessionId,
				kind: "thread",
				title: "",
				startedAt,
				updatedAt: startedAt,
				messageCount: 0,
				current: true,
			});
		}
		for (const action of this.readActions()) {
			if (needle && !JSON.stringify(action).toLowerCase().includes(needle)) continue;
			entries.push(actionEntry(action));
		}
		return entries.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async read(entryId: string): Promise<TranscriptItem[]> {
		if (entryId === this.sessionId) return this.transcript();
		const action = this.readActions().find((a) => a.id === entryId);
		if (action) return actionTranscript(action);
		const path = await this.findSession(entryId);
		if (!path) throw new EngineError(`No history entry "${entryId}"`, "engine");
		return transcriptItems(SessionManager.open(path, this.sessionDir, this.dataDir).getBranch(), this.undoneSaves());
	}

	/** The prompt preamble this thread was started with (pi stores it as a system message), if any. */
	frozenPrompt(): string | undefined {
		let preamble: string | undefined;
		for (const entry of this.manager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "system") continue;
			const sections = (entry.message as { sections?: Record<string, unknown> }).sections;
			if (typeof sections?.preamble === "string") preamble = sections.preamble;
		}
		return preamble;
	}

	transcript(): TranscriptItem[] {
		return transcriptItems(this.manager.getBranch(), this.undoneSaves());
	}

	/** Append one finished one-off action to engine\actions.jsonl. */
	recordAction(line: ActionLogLine): void {
		appendFileSync(this.actionsPath, `${JSON.stringify(line)}\n`);
	}

	/** engine\actions.jsonl, written by recordAction. */
	private readActions(): ActionLogLine[] {
		if (!existsSync(this.actionsPath)) return [];
		const lines: ActionLogLine[] = [];
		for (const line of readFileSync(this.actionsPath, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as ActionLogLine;
				if (parsed && typeof parsed.id === "string") lines.push(parsed);
			} catch {
				// Skip a torn line.
			}
		}
		return lines;
	}
}

/** One line of engine\actions.jsonl. The reader is lenient: only id is required. */
export interface ActionLogLine {
	id: string;
	name?: string;
	selection?: string;
	text?: string;
	output?: "replace" | "show";
	at?: number;
}

/** User and assistant messages in a session file (pi's own count includes system messages). */
function countMessages(path: string): number {
	try {
		return readFileSync(path, "utf8").match(/"type":"message",[^\n]*?"message":\{"role":"(user|assistant)"/g)?.length ?? 0;
	} catch {
		return 0;
	}
}

function titleOf(text: string): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function actionEntry(action: ActionLogLine): HistoryEntry {
	const at = action.at ?? 0;
	return {
		id: action.id,
		kind: "action",
		title: titleOf(`${action.name ?? "Action"}: ${action.selection ?? ""}`),
		startedAt: at,
		updatedAt: at,
		messageCount: 2,
		current: false,
	};
}

function actionTranscript(action: ActionLogLine): TranscriptItem[] {
	const at = action.at ?? 0;
	return [
		{ kind: "user", id: `${action.id}:in`, text: `${action.name ?? "Action"}: ${action.selection ?? ""}`, images: 0, at },
		{ kind: "assistant", id: `${action.id}:out`, text: action.text ?? "", at },
	];
}

type Block = { type: string; text?: string; id?: string; name?: string; arguments?: unknown };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Block[]).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}

function clip(text: string, max = 80): string {
	const line = (text.trim().split("\n")[0] ?? "").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Last part of a path: "C:\\Users\\x\\notes.txt" → "notes.txt". */
function baseName(path: string): string {
	const parts = path.trim().replace(/[\\/]+$/, "").split(/[\\/]/);
	return parts.at(-1) || path.trim();
}

/** One short line for a tool call, shown after the tool name: "Get-ChildItem Downloads", "notes.txt". */
export function toolSummary(name: string, args: unknown): string {
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const str = (key: string) => (typeof a[key] === "string" ? (a[key] as string) : "");
	switch (name) {
		case "bash":
		case "powershell":
			return clip(str("command")) || name;
		case "read":
		case "write":
		case "edit":
			return str("path") ? baseName(str("path")) : name;
		case "ls":
			return str("path") ? clip(str("path")) : "~";
		case "find":
		case "grep":
			return clip([str("pattern"), str("path") ? `in ${str("path")}` : ""].filter(Boolean).join(" ")) || name;
		case "open":
			return clip(str("target")) || name;
		case "web_fetch":
			return clip(str("url")) || name;
		case "web_search":
			return clip(str("query")) || name;
		case "look_at_screen":
			return "the active window";
		case "desktop_observe":
			return clip(str("root") || str("window") || str("surface")) || "the active window";
		case "desktop_act":
			return clip([str("action").replace(/_/g, " "), str("ref")].filter(Boolean).join(" ")) || name;
		case "desktop_press":
			return clip(str("keys")) || name;
		case "desktop_windows":
			return "open windows";
		case "desktop_window":
			return clip([str("action"), str("app") || str("window")].filter(Boolean).join(" ")) || name;
		case "desktop_wait":
			return clip(str("text") || str("role") || (typeof a.ms === "number" ? `${a.ms} ms` : "")) || name;
		case "memory_save":
			return clip(str("title")) || name;
		case "memory_read":
			return clip(str("topic")) || name;
		case "voice_propose":
			return clip(str("profile")) || name;
	}
	const first = Object.values(a).find((v) => typeof v === "string") as string | undefined;
	return first ? clip(first) : name;
}

/** Build transcript rows from a session branch (root → leaf). */
export function transcriptItems(entries: SessionEntry[], undoneSaves: ReadonlySet<string> = new Set()): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	const tools = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
	/** memory_save calls wait for their result: a successful one becomes a memory_saved row. */
	const saves = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
	for (const entry of entries) {
		const at = Date.parse(entry.timestamp);
		if (entry.type === "compaction") {
			items.push({ kind: "compaction", id: entry.id, summary: entry.summary, at });
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message as { role: string; content?: unknown } & Record<string, unknown>;
		if (message.role === "user") {
			const { text, now, spoken } = parseNow(textOf(message.content));
			const images = Array.isArray(message.content)
				? (message.content as Block[]).filter((b) => b.type === "image").length
				: 0;
			items.push({ kind: "user", id: entry.id, text, images, ...(now ? { now } : {}), ...(spoken ? { spoken } : {}), at });
		} else if (message.role === "assistant") {
			const blocks = (Array.isArray(message.content) ? message.content : []) as Block[];
			// A spoken reply's <say> blocks aren't part of what was written; if nothing was, the
			// last block was shown as the reply (reply.ts), so it is here too.
			const { text: raw, mood } = stripMood(textOf(blocks));
			const split = splitSay(raw);
			const text = split.text.trim() ? split.text : (split.said.at(-1) ?? "");
			const stopReason = message.stopReason as string | undefined;
			if (text || stopReason === "aborted") {
				items.push({
					kind: "assistant",
					id: entry.id,
					text,
					...(mood ? { mood } : {}),
					...(stopReason === "aborted" ? { aborted: true } : {}),
					at,
				});
			}
			for (const block of blocks) {
				if (block.type !== "toolCall" || !block.id || !block.name) continue;
				const item = {
					kind: "tool" as const,
					id: `${entry.id}:${block.id}`,
					name: block.name,
					summary: toolSummary(block.name, block.arguments),
					ok: null,
					at,
				};
				if (block.name === "memory_save") {
					saves.set(block.id, item);
					continue;
				}
				tools.set(block.id, item);
				items.push(item);
			}
			if (stopReason === "error") {
				const errorMessage = (message.errorMessage as string | undefined) ?? "The model returned an error";
				items.push({ kind: "error", id: `${entry.id}:error`, errorKind: classifyError(errorMessage), message: errorMessage, at });
			}
		} else if (message.role === "toolResult") {
			const save = saves.get(message.toolCallId as string);
			if (save) {
				const details = message.details as { saveId?: unknown; title?: unknown } | undefined;
				if (!message.isError && typeof details?.saveId === "string") {
					items.push({
						kind: "memory_saved",
						id: save.id,
						saveId: details.saveId,
						title: typeof details.title === "string" ? details.title : "",
						undone: undoneSaves.has(details.saveId),
						at: save.at,
					});
					continue;
				}
				// A failed save stays a generic tool row.
				tools.set(message.toolCallId as string, save);
				items.push(save);
			}
			const tool = tools.get(message.toolCallId as string);
			if (tool) {
				tool.ok = !message.isError;
				const detail = textOf(message.content);
				if (detail) tool.detail = detail;
			}
		}
	}
	return items;
}
