// Ties the pieces together: runtime + thread + the live AgentSession + replies.
// The AgentSession is a view over the thread's SessionManager; it is rebuilt (and its events
// re-attached) whenever the provider, model or current thread changes.
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createExtensionRuntime,
	type ModelRuntime,
	type ResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { FAUX_PROVIDER, type FauxOptions } from "./faux.ts";
import { buildSystemPrompt } from "./prompt.ts";
import type { ConfigureCommand, Event, ModelChoice, ModelRole, ThinkingLevel } from "./protocol.ts";
import { Replies } from "./reply.ts";
import { clampThinking, createRuntime, modelInfo, resolveModel, thinkingLevels } from "./runtime.ts";
import { Thread } from "./thread.ts";

/** configure as the engine accepts it: the protocol command plus a test-only faux script. */
export type EngineConfig = ConfigureCommand & { faux?: FauxOptions };

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
	private quick: ModelChoice | undefined;
	readonly replies: Replies;

	constructor(private readonly emit: (event: Event) => void) {
		this.replies = new Replies(
			emit,
			() => this.emitContext(),
			(ok) => {
				if (ok) void this.refreezePrompt();
			},
		);
	}

	get configured(): boolean {
		return !!this.session;
	}

	private freshPrompt(): string {
		return buildSystemPrompt({ assistantStyle: this.config.assistantStyle ?? "" });
	}

	/** The prompt the current thread started with, so a restart or restore doesn't break the cache. */
	private threadPrompt(): string {
		return this.thread.frozenPrompt() ?? this.freshPrompt();
	}

	async configure(config: EngineConfig): Promise<void> {
		// Validate everything before touching the running session.
		const mainId = config.main.id;
		const quickId = config.quick?.id;
		const runtime = await createRuntime({
			provider: config.provider,
			apiKey: config.apiKey,
			modelIds: [mainId, ...(quickId ? [quickId] : [])],
			faux: config.provider.kind === "catalog" && config.provider.id === FAUX_PROVIDER ? config.faux : undefined,
		});
		const model = resolveModel(runtime, config.provider, mainId);
		if (quickId) resolveModel(runtime, config.provider, quickId);

		await this.stop();
		this.config = config;
		this.runtime = runtime;
		this.model = model;
		this.quick = config.quick;
		if (!this.thread || this.thread.dataDir !== config.dataDir) {
			this.thread = new Thread(config.dataDir);
			this.systemPrompt = this.threadPrompt();
		}
		await this.openSession(clampThinking(model, config.main.thinking));
		this.emit(this.readyEvent());
		this.emitContext();
	}

	/** Abort any reply and detach from the current session. */
	private async stop(): Promise<void> {
		if (!this.session) return;
		if (this.replies.busy) await this.replies.abort();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
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
			}),
			sessionManager: this.thread.manager,
			tools: [],
		});
		this.session = session;
		this.unsubscribe = this.replies.attach(session);
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

	/** After compaction the prompt may pick up changes (style now; memory and voice from step 5). */
	private async refreezePrompt(): Promise<void> {
		const next = this.freshPrompt();
		if (next === this.systemPrompt || !this.session) return;
		this.systemPrompt = next;
		try {
			await this.session.reload();
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
		let result = { undoToken: "" };
		await this.swapThread("clear", () => {
			result = this.thread.clear();
		});
		return result;
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

	get threadState(): Thread {
		if (!this.thread) throw new Error("Engine is not configured");
		return this.thread;
	}

	get levels(): ThinkingLevel[] {
		return thinkingLevels(this.model);
	}

	async dispose(): Promise<void> {
		await this.stop();
	}
}
