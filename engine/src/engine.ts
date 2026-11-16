// Ties the pieces together: runtime + thread + the live AgentSession + replies.
// The AgentSession is a view over the thread's SessionManager; it is rebuilt (and its events
// re-attached) whenever the provider, model or current thread changes.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createExtensionRuntime,
	type ModelRuntime,
	type ResourceLoader,
	type SessionEntry,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type ActionSetup, Actions, type OneOffAction } from "./action.ts";
import { FAUX_PROVIDER, type FauxOptions } from "./faux.ts";
import { CORE_FILES, type CoreKind, coreBody, coreForPrompt, coreFromBody, ensureStarterFiles, MemoryStore, memoryTools } from "./memory.ts";
import { buildSystemPrompt } from "./prompt.ts";
import type { Command, ConfigureCommand, Event, MemoryCore, MemoryOverview, ModelChoice, ModelRole, ThinkingLevel, VoiceProfileInfo } from "./protocol.ts";
import { type Embed, formatRecalled, RecallIndex } from "./recall.ts";
import { Replies } from "./reply.ts";
import type { ShellRequests } from "./requests.ts";
import { capContextWindow, clampThinking, createRuntime, errorOf, modelInfo, resolveModel, thinkingLevels } from "./runtime.ts";
import { NOTICE_TYPE, Thread } from "./thread.ts";
import { IDLE_DELAY_MS, Tidy, type TidyModel, type TidyReason } from "./tidy.ts";
import { cliRunner, findAgentDesktop } from "./tools/desktop/cli.ts";
import { installImageDrop } from "./tools/images.ts";
import { activeToolNames, type AnyTool, agentTools } from "./tools/index.ts";
import { type PermissionPolicy, policyFrom } from "./tools/permission.ts";
import { hasRipgrep, localShells } from "./tools/shell.ts";
import { VoiceProfiles, voiceTools } from "./voice.ts";

/** configure as the engine accepts it: the protocol command plus a test-only faux script. */
export type EngineConfig = ConfigureCommand & { faux?: FauxOptions };

/** configure fields that update in place, without reopening the session (so a running reply carries on). */
const LIVE_FIELDS = ["id", "type", "askBeforeRunning", "alwaysAllow", "searchApiKey", "memoryRecall", "memoryTidy"] as const;

/** The memory tools, active in every thread. */
const MEMORY_TOOLS = ["memory_save", "memory_read", "memory_search", "voice_propose"];

type PromptCommand = Extract<Command, { type: "prompt" }>;

/** Vectors arrive as base64 of little-endian f32 (protocol.ts `embed`). */
function decodeVector(b64: unknown): Float32Array {
	const bytes = new Uint8Array(Buffer.from(String(b64), "base64"));
	return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
}

/** JSON with object keys sorted at every level, so key order doesn't matter. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value)
			.filter((k) => (value as Record<string, unknown>)[k] !== undefined)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

function sameExceptLive(a: EngineConfig, b: EngineConfig): boolean {
	const strip = (c: EngineConfig) => {
		const copy: Record<string, unknown> = { ...c };
		for (const key of LIVE_FIELDS) delete copy[key];
		return canonical(copy);
	};
	return strip(a) === strip(b);
}

function isolatedResourceLoader(getSystemPrompt: () => string): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

export class Engine {
	private config!: EngineConfig;
	private runtime!: ModelRuntime;
	private model!: Model<Api>;
	private thread!: Thread;
	private session: AgentSession | undefined;
	private unsubscribe: (() => void) | undefined;
	/** Frozen for the thread until clear or compaction, so the provider's prompt cache keeps hitting. */
	private systemPrompt = "";
	/** A new snapshot waits for the session to be idle before pi picks it up. */
	private reloadPending = false;
	private quick: ModelChoice | undefined;
	private memory: MemoryStore | undefined;
	private recall: RecallIndex | undefined;
	private tidy: Tidy | undefined;
	/** Starts a tidy after a quiet spell (IDLE_DELAY_MS, or faux.tidyIdleMs in tests). */
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** Counts aborts, so a prompt still searching memory knows Esc came. */
	private aborts = 0;
	private voice: VoiceProfiles | undefined;
	/** Ask before running + Always allow; read by the permission gate on every call. */
	private policy: PermissionPolicy = policyFrom(false, []);
	private searchApiKey: string | undefined;
	private agentToolList: AnyTool[] = [];
	/** The tool set changed (search key) while a reply ran; applied once it settles. */
	private toolsPending = false;
	readonly replies: Replies;
	readonly actions: Actions;

	constructor(
		private readonly emit: (event: Event) => void,
		private readonly requests: ShellRequests,
	) {
		this.actions = new Actions(emit);
		this.replies = new Replies(
			emit,
			() => {
				this.emitContext();
				this.flushTools();
				void this.flushReload();
				this.armIdleTidy();
			},
			(ok) => {
				if (ok) void this.refreezePrompt();
			},
		);
	}

	get configured(): boolean {
		return !!this.session;
	}

	/** Re-reads about-me.md, the voice profiles and the core memory files: a new snapshot. */
	private freshPrompt(): string {
		let aboutMe = "";
		try {
			aboutMe = readFileSync(join(this.config.dataDir, "about-me.md"), "utf8");
		} catch {}
		// The starter template is only an HTML comment; leave it out until the user writes something.
		aboutMe = aboutMe.replace(/<!--[\s\S]*?-->/g, "");
		const memory = this.requireMemory();
		return buildSystemPrompt({
			assistantStyle: this.config.assistantStyle ?? "",
			aboutMe,
			voiceProfiles: this.requireVoice().all(),
			profile: coreForPrompt("profile", memory.core("profile")),
			goals: coreForPrompt("goals", memory.core("goals")),
			recap: coreForPrompt("recap", memory.core("recap")),
			noteTopics: memory.topics(),
		});
	}

	private requireMemory(): MemoryStore {
		if (!this.memory) throw new Error("Engine is not configured");
		return this.memory;
	}

	private requireVoice(): VoiceProfiles {
		if (!this.voice) throw new Error("Engine is not configured");
		return this.voice;
	}

	/** The prompt the current thread started with, so a restart or restore doesn't break the cache. */
	private threadPrompt(): string {
		return this.thread.frozenPrompt() ?? this.freshPrompt();
	}

	private applyLive(config: EngineConfig): void {
		this.policy = policyFrom(!!config.askBeforeRunning, config.alwaysAllow ?? []);
		this.searchApiKey = config.searchApiKey || undefined;
		if (config.memoryTidy === false) this.disarmIdleTidy();
	}

	private get recallOn(): boolean {
		return this.config?.memoryRecall !== false;
	}

	private get tidyOn(): boolean {
		return this.config?.memoryTidy !== false;
	}

	/** The shell's embedder (protocol `embed`). */
	private readonly embed: Embed = async (texts, query, timeoutMs) => {
		if (!this.recallOn) throw new Error("recall_off");
		const data = (await this.requests.request("embed", { texts, query }, { timeoutMs })) as { vectors?: unknown } | undefined;
		if (!Array.isArray(data?.vectors) || data.vectors.length !== texts.length) throw new Error("The embedder sent no vectors");
		return data.vectors.map(decodeVector);
	};

	/**
	 * Send a prompt with the notes that relate to it (SPEC §9 Recall). Steers like Replies.prompt.
	 * Recall waits at most QUERY_TIMEOUT_MS for the shell and never fails the prompt.
	 */
	async prompt(command: PromptCommand): Promise<boolean> {
		this.disarmIdleTidy();
		let recalled = "";
		if (this.recallOn && this.recall && this.memory?.topics().length) {
			const generation = this.aborts;
			// The eyes start thinking at once, not after the search.
			if (!this.replies.busy) this.emit({ type: "thinking", id: command.id });
			const selection = command.now?.selection ? `\n${command.now.selection.slice(0, 500)}` : "";
			const notes = await this.recall.search(`${command.text}${selection}`, { exclude: this.thread.recalledInContext() });
			if (generation !== this.aborts) {
				// Esc while searching: the prompt never went out.
				this.emit({ type: "reply_end", id: command.id, text: "", aborted: true });
				return false;
			}
			recalled = formatRecalled(notes);
		}
		return this.replies.prompt(command, recalled);
	}

	private disarmIdleTidy(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	/** After a reply settles: tidy the thread once it has been quiet for a while. */
	private armIdleTidy(): void {
		this.disarmIdleTidy();
		if (!this.tidyOn || !this.tidy) return;
		const delay = this.config.faux?.tidyIdleMs ?? IDLE_DELAY_MS;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			if (this.replies.busy || !this.session) return;
			void this.runTidy(this.thread.sessionId, () => this.thread.entries(), "idle");
		}, delay);
		// Don't keep the process alive for it.
		(this.idleTimer as { unref?: () => void }).unref?.();
	}

	private tidyModel(): TidyModel {
		const quick = this.quickChoice();
		const model = resolveModel(this.runtime, this.config.provider, quick.id);
		return { runtime: this.runtime, model, thinking: clampThinking(model, quick.thinking) };
	}

	/** Run a tidy pass and report it. Resolves with whether memory changed; never rejects. */
	private async runTidy(sessionId: string, entries: () => SessionEntry[], reason: TidyReason, force = false): Promise<boolean> {
		const tidy = this.tidy;
		if (!tidy) return false;
		this.emit({ type: "memory_tidy", state: "running" });
		try {
			const changed = await tidy.run({ sessionId, entries }, reason, () => this.tidyModel(), { force });
			this.emit({ type: "memory_tidy", state: "done", changed });
			if (changed) {
				this.emit({ type: "memory_changed", reason: "tidy" });
				if (this.recallOn) this.recall?.warm();
				// A thread with no messages yet has no cache to break: give it the new memory now.
				if (this.thread && !this.thread.entries().some((e) => e.type === "message")) await this.refreezePrompt();
			}
			return changed;
		} catch (error) {
			const message = errorOf(error).message;
			this.emit({ type: "memory_tidy", state: "failed", message });
			return false;
		}
	}

	/** Settings > Memory: what memory holds. */
	memoryOverview(): MemoryOverview {
		this.requireSession();
		const memory = this.requireMemory();
		const notes = memory
			.notes()
			.sort((a, b) => b.date - a.date)
			.map((n) => ({
				id: n.id,
				topic: n.topic,
				title: n.title,
				date: n.date,
				preview: n.body.replace(/\s+/g, " ").trim().slice(0, 140),
				important: n.important,
			}));
		return {
			profile: coreBody("profile", memory.core("profile")),
			goals: coreBody("goals", memory.core("goals")),
			recap: coreBody("recap", memory.core("recap")),
			notes,
			indexed: this.recall?.stats() ?? { notes: 0, embedded: 0 },
			lastTidy: this.tidy?.lastTidy ?? null,
			tidying: this.tidy?.running ?? false,
		};
	}

	setMemoryCore(which: MemoryCore, text: string): void {
		this.requireSession();
		if (!(which in CORE_FILES)) throw new Error(`Unknown memory file "${which}"`);
		this.requireMemory().setCore(which as CoreKind, coreFromBody(which as CoreKind, text));
		this.emit({ type: "memory_changed", reason: "edit" });
	}

	deleteMemoryNote(topic: string, noteId: string): void {
		this.requireSession();
		this.requireMemory().deleteNote(topic, noteId);
		this.emit({ type: "memory_changed", reason: "edit" });
	}

	/** Settings "Tidy now": the current thread since its last pass, even a short one. */
	async tidyNow(): Promise<{ changed: boolean }> {
		this.requireSession();
		return { changed: await this.runTidy(this.thread.sessionId, () => this.thread.entries(), "manual", true) };
	}

	async configure(config: EngineConfig): Promise<void> {
		// Only tool settings changed: update in place, don't disturb a running reply or the thread.
		if (this.session && this.config && sameExceptLive(this.config, config)) {
			this.config = config;
			this.applyLive(config);
			this.toolsPending = true;
			this.flushTools();
			this.emit(this.readyEvent());
			return;
		}
		// Validate everything before touching the running session.
		const mainId = config.main.id;
		const quickId = config.quick?.id;
		const runtime = await createRuntime({
			provider: config.provider,
			apiKey: config.apiKey,
			modelIds: [mainId, ...(quickId ? [quickId] : [])],
			faux: config.provider.kind === "catalog" && config.provider.id === FAUX_PROVIDER ? config.faux : undefined,
		});
		const model = capContextWindow(resolveModel(runtime, config.provider, mainId), config.contextLimit);
		if (quickId) resolveModel(runtime, config.provider, quickId);

		await this.stop();
		this.config = config;
		this.applyLive(config);
		this.runtime = runtime;
		this.model = model;
		this.quick = config.quick;
		if (!this.thread || this.thread.dataDir !== config.dataDir) {
			ensureStarterFiles(config.dataDir);
			this.thread = new Thread(config.dataDir);
			const memory = new MemoryStore(config.dataDir);
			this.memory = memory;
			this.recall?.close();
			this.recall = new RecallIndex(memory, RecallIndex.pathFor(config.dataDir), this.embed);
			this.tidy = new Tidy(config.dataDir, () => memory);
			this.voice = new VoiceProfiles(config.dataDir);
			this.thread.undoneSaves = () => memory.undone();
			this.systemPrompt = this.threadPrompt();
		}
		await this.openSession(clampThinking(model, config.main.thinking));
		// Notes edited while Winku was closed get their vectors before the first message.
		if (this.recallOn) this.recall?.warm();
		this.emit(this.readyEvent());
		this.emitContext();
	}

	/** Abort any reply and detach from the current session. */
	private async stop(): Promise<void> {
		if (!this.session) return;
		if (this.replies.busy) await this.replies.abort();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.reloadPending = false;
		this.session.dispose();
		this.session = undefined;
	}

	private async openSession(thinking: ThinkingLevel): Promise<void> {
		const reserveTokens = this.config.compactionReserveTokens;
		const faux = this.config.provider.kind === "catalog" && this.config.provider.id === FAUX_PROVIDER;
		const keepRecentTokens = faux ? this.config.faux?.keepRecentTokens : undefined;
		const { session } = await createAgentSession({
			cwd: this.config.dataDir,
			agentDir: this.thread.engineDir,
			model: this.model,
			thinkingLevel: thinking,
			modelRuntime: this.runtime,
			resourceLoader: isolatedResourceLoader(() => this.systemPrompt),
			settingsManager: SettingsManager.inMemory({
				compaction: {
					enabled: true,
					...(reserveTokens !== undefined ? { reserveTokens } : {}),
					...(keepRecentTokens !== undefined ? { keepRecentTokens } : {}),
				},
				retry: { enabled: !faux, maxRetries: 2 },
				// A message sent mid-reply steers it; every waiting one goes in at the next step (#44).
				steeringMode: "all",
			}),
			sessionManager: this.thread.manager,
			customTools: this.tools(),
			tools: [...this.agentToolList.map((t) => t.name), ...MEMORY_TOOLS],
		});
		installImageDrop(session);
		this.session = session;
		this.unsubscribe = this.replies.attach(session);
		// Set the loadout explicitly: a thread from before step 6 recorded only the memory tools.
		this.toolsPending = true;
		this.flushTools();
	}

	/** Activate the agent tools (web_search only with a search key), once nothing is running. */
	private flushTools(): void {
		const session = this.session;
		if (!this.toolsPending || !session || session.isStreaming || session.isCompacting) return;
		this.toolsPending = false;
		const wanted = [...activeToolNames(this.agentToolList, !!this.searchApiKey), ...MEMORY_TOOLS];
		const current = session.getActiveToolNames();
		if (current.length === wanted.length && wanted.every((name) => current.includes(name))) return;
		session.setActiveToolsByName(wanted);
	}

	/** Computer use when agent-desktop is bundled beside the engine. Its state lives in engine\agent-desktop. */
	private desktop() {
		const bin = findAgentDesktop();
		if (!bin || !this.config) return {};
		const run = cliRunner(bin, join(this.config.dataDir, "engine", "agent-desktop"));
		// The shell started the engine: its windows are Winku's.
		return { desktop: { run, ownPids: [process.ppid] } };
	}

	private tools() {
		this.agentToolList = agentTools({
			home: homedir(),
			dataDir: () => this.config.dataDir,
			shells: localShells(),
			ripgrep: hasRipgrep(),
			policy: () => this.policy,
			requests: this.requests,
			replyId: () => this.replies.activeId,
			threadVisuals: () => this.thread.visualIds(),
			scheduledRun: () => this.replies.activeScheduled,
			spoken: () => this.replies.activePromptSpoken,
			supportsImages: () => modelInfo(this.model).supportsImages,
			searchKey: () => this.searchApiKey,
			...this.desktop(),
		});
		const memory = memoryTools(
			() => this.requireMemory(),
			() => this.thread.sessionId,
			(save) => {
				const id = this.replies.activeId;
				this.emit({ type: "memory_saved", ...(id ? { id } : {}), saveId: save.saveId, title: save.title });
				if (this.recallOn) this.recall?.warm();
			},
			async (query) => {
				const notes = (await this.recall?.search(query, { limit: 8, budget: 6000, timeoutMs: 2000, loose: true })) ?? [];
				if (!notes.length) return "Nothing in memory matches that.";
				return notes.map((n) => `## ${n.topic}: ${n.title} (${new Date(n.date).toISOString().slice(0, 10)})\n${n.body}`).join("\n\n");
			},
		);
		const voice = voiceTools(
			() => this.requireVoice(),
			(proposal) => {
				const id = this.replies.activeId;
				this.emit({ type: "voice_proposal", ...(id ? { id } : {}), ...proposal });
			},
		);
		return [...this.agentToolList, ...memory, ...voice];
	}

	/**
	 * A scheduler notice: recorded in the thread (a custom message, so it persists and the model
	 * reads it with its next call) without starting a turn. While a reply runs, pi appends it once
	 * the current step's tool results are in.
	 */
	async notice(text: string): Promise<void> {
		const session = this.requireSession();
		await session.sendCustomMessage({ customType: NOTICE_TYPE, content: text, display: true }, { triggerTurn: false });
		this.emit({ type: "notice", text, at: Date.now() });
	}

	undoMemory(saveId: string): void {
		this.requireSession();
		this.requireMemory().undo(saveId, this.thread.sessionId);
		this.emit({ type: "memory_undone", saveId });
		this.emit({ type: "memory_changed", reason: "undo" });
	}

	forgetMemory(): number {
		this.requireSession();
		const removed = this.requireMemory().forgetAll();
		this.recall?.reset();
		this.tidy?.reset();
		this.emit({ type: "memory_changed", reason: "forget" });
		return removed;
	}

	voiceDecision(proposalId: string, accept: boolean): { written: boolean } {
		this.requireSession();
		return this.requireVoice().decide(proposalId, accept);
	}

	voiceList(): VoiceProfileInfo[] {
		this.requireSession();
		return this.requireVoice().list();
	}

	private readyEvent(): Event {
		const info = modelInfo(this.model);
		return {
			type: "ready",
			provider: this.model.provider,
			model: this.model.id,
			contextWindow: info.contextWindow,
			supportsImages: info.supportsImages,
			thinking: (this.session?.thinkingLevel ?? "off") as ThinkingLevel,
			thinkingLevels: info.thinkingLevels,
		};
	}

	emitContext(): void {
		if (!this.session) return;
		const usage = this.session.getContextUsage();
		this.emit({
			type: "context",
			tokens: usage?.tokens ?? null,
			contextWindow: usage?.contextWindow ?? this.model.contextWindow,
			percent: usage?.percent ?? null,
		});
	}

	/** After compaction the prompt picks up changes: style, About me, voice profiles, MEMORY.md. */
	private async refreezePrompt(): Promise<void> {
		const next = this.freshPrompt();
		if (next === this.systemPrompt || !this.session) return;
		this.systemPrompt = next;
		this.reloadPending = true;
		await this.flushReload();
	}

	/** pi can't reload mid-run (threshold compaction happens inside one), so wait until it settles. */
	private async flushReload(): Promise<void> {
		const session = this.session;
		if (!this.reloadPending || !session || session.isStreaming || session.isCompacting) return;
		this.reloadPending = false;
		try {
			await session.reload();
		} catch (error) {
			process.stderr.write(`prompt reload failed: ${String(error)}\n`);
		}
	}

	private requireSession(): AgentSession {
		if (!this.session) throw new Error("Engine is not configured");
		return this.session;
	}

	/** Swap the current thread: stop, run the thread change, reopen, announce. */
	private async swapThread(reason: "clear" | "undo_clear" | "restore", change: () => Promise<void> | void): Promise<void> {
		const session = this.requireSession();
		const thinking = session.thinkingLevel as ThinkingLevel;
		await this.stop();
		this.voice?.dropPending();
		try {
			await change();
		} finally {
			this.systemPrompt = this.threadPrompt();
			await this.openSession(thinking);
		}
		this.emit({ type: "thread_changed", reason, sessionId: this.thread.sessionId });
		this.emitContext();
	}

	async clear(): Promise<{ undoToken: string }> {
		let result: { undoToken: string; archivedFile?: string } = { undoToken: "" };
		const archivedId = this.thread.sessionId;
		this.disarmIdleTidy();
		await this.swapThread("clear", () => {
			result = this.thread.clear();
		});
		// Tidy the thread just cleared, in the background (SPEC §9 Tidy).
		const file = result.archivedFile;
		if (file && this.tidyOn) {
			const thread = this.thread;
			void this.runTidy(archivedId, () => thread.entries(file), "clear");
		}
		return { undoToken: result.undoToken };
	}

	async undoClear(token: string): Promise<void> {
		await this.swapThread("undo_clear", () => this.thread.undoClear(token));
	}

	async restore(entryId: string): Promise<void> {
		await this.swapThread("restore", () => this.thread.restore(entryId));
	}

	setThinking(role: ModelRole, level: ThinkingLevel): ThinkingLevel {
		const session = this.requireSession();
		if (role === "main") {
			const clamped = clampThinking(this.model, level);
			session.setThinkingLevel(clamped);
			this.emit({ type: "thinking_changed", role, level: session.thinkingLevel as ThinkingLevel });
			return session.thinkingLevel as ThinkingLevel;
		}
		const quickModel = this.quick ? resolveModel(this.runtime, this.config.provider, this.quick.id) : this.model;
		const clamped = clampThinking(quickModel, level);
		this.quick = { id: quickModel.id, thinking: clamped };
		this.emit({ type: "thinking_changed", role, level: clamped });
		return clamped;
	}

	/** Quick model for one-off actions (step 4). Absent in configure = follow main, thinking off. */
	quickChoice(): ModelChoice {
		return this.quick ?? { id: this.model.id, thinking: "off" };
	}

	/** Start a replace/show action on the Quick model. Runs apart from the thread's reply. */
	runOneOff(command: OneOffAction): void {
		if (!this.session) throw new Error("Engine is not configured");
		const quick = this.quickChoice();
		const model = resolveModel(this.runtime, this.config.provider, quick.id);
		const thread = this.thread;
		const setup: ActionSetup = {
			runtime: this.runtime,
			model,
			thinking: clampThinking(model, quick.thinking),
			assistantStyle: this.config.assistantStyle ?? "",
			voiceProfile: (name) => {
				const voice = this.requireVoice();
				const fallback = this.config.defaultVoiceProfile;
				return (name ? voice.read(name) : undefined) ?? (fallback ? voice.read(fallback) : undefined);
			},
			transcript: () => thread.transcript(),
			record: (line) => thread.recordAction(line),
		};
		void this.actions.start(command, setup);
	}

	/** Stop whatever is running: the reply and any one-off actions. */
	async abort(): Promise<void> {
		this.aborts++;
		this.actions.abort();
		await this.replies.abort();
	}

	get threadState(): Thread {
		if (!this.thread) throw new Error("Engine is not configured");
		return this.thread;
	}

	get levels(): ThinkingLevel[] {
		return thinkingLevels(this.model);
	}

	async dispose(): Promise<void> {
		this.disarmIdleTidy();
		await this.stop();
		this.recall?.close();
	}
}
