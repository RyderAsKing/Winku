// The main window's interaction state: pill ↔ bar ↔ transcript, the current reply, chips,
// toasts and the eyes. Engine events and shell `ui` events come in here; components render it.
import type {
	ErrorKind,
	ImageAttachment,
	ThinkingLevel,
	TranscriptItem,
} from "../../../../engine/src/protocol.ts";
import { EyeController, saysThanks } from "../lib/eyes/controller.svelte.ts";
import { TINTS } from "../lib/eyes/look.ts";
import type { Settings } from "../lib/settings.ts";
import { type EngineMessage, newId, onEngine, onSettingsChanged, onUi, shell, type UiEvent, type WindowMode } from "../lib/shell.ts";

export interface LiveTool {
	toolCallId: string;
	name: string;
	summary: string;
	ok: boolean | null;
}

export interface Reply {
	id: string;
	kind: "prompt" | "action";
	text: string;
	done: boolean;
	aborted: boolean;
	tools: LiveTool[];
	error?: { kind: ErrorKind; message: string };
	saved?: { saveId: string; title: string; undone: boolean }[];
}

export interface Toast {
	text: string;
	action?: { label: string; run: () => void };
	until: number;
}

interface ReadyInfo {
	provider: string;
	model: string;
	contextWindow: number;
	supportsImages: boolean;
	thinking: ThinkingLevel;
	thinkingLevels: ThinkingLevel[];
}

const UNDO_MS = 5000;

export class MainState {
	readonly eyes = new EyeController();

	settings: Settings | null = $state(null);
	hasKey = $state(false);
	mode: WindowMode = $state("pill");
	ready: ReadyInfo | null = $state(null);
	contextPercent: number | null = $state(null);
	reply: Reply | null = $state(null);
	busy = $state(false);
	transcript: TranscriptItem[] = $state([]);
	transcriptLoading = $state(false);
	selectionChip: string | null = $state(null);
	imageChip: ImageAttachment | null = $state(null);
	toast: Toast | null = $state(null);
	/** Bumped to ask the input to take focus. */
	focusTick = $state(0);

	readonly needsConnect: boolean = $derived(
		this.settings !== null &&
			(!this.settings.provider ||
				!this.settings.main ||
				(this.settings.provider.kind === "catalog" && !this.hasKey)),
	);
	readonly thinking: ThinkingLevel = $derived(this.ready?.thinking ?? this.settings?.main?.thinking ?? "medium");
	readonly tint: string = $derived(TINTS[this.thinking]);
	/** Lids lower gradually once context passes 20%, up to 30% closed at the limit (SPEC §4). */
	readonly lid: number = $derived(
		this.contextPercent === null ? 0 : 0.3 * Math.min(1, Math.max(0, (this.contextPercent - 20) / 80)) ** 1.3,
	);

	#lastUserText = "";
	#toastTimer: ReturnType<typeof setTimeout> | undefined;

	async init() {
		await Promise.all([onEngine((m) => this.#onEngine(m)), onUi((e) => this.#onUi(e)), onSettingsChanged((s) => this.#onSettings(s))]);
		const [settings, hasKey] = await Promise.all([shell.settingsGet(), shell.secretPresent()]);
		this.hasKey = hasKey;
		this.settings = settings;
	}

	// ── window ──

	async summon() {
		this.eyes.touch();
		if (this.mode === "pill") await this.#setMode("bar");
		this.focusTick += 1;
	}

	async hide() {
		await this.#setMode("pill");
		this.selectionChip = null;
		this.imageChip = null;
	}

	async toggleTranscript() {
		if (this.mode === "transcript") {
			await this.#setMode("bar");
		} else {
			await this.#setMode("transcript");
			await this.loadTranscript();
		}
		this.focusTick += 1;
	}

	async #setMode(mode: WindowMode) {
		this.mode = mode;
		this.eyes.setBarVisible(mode !== "pill");
		await shell.windowMode(mode);
	}

	/** Esc: first press stops the reply, a second press hides the bar (SPEC §5). */
	async escape() {
		if (this.busy) {
			await shell.send({ type: "abort" });
			await shell.stopSpeaking().catch(() => {});
			return;
		}
		await this.hide();
	}

	// ── conversation ──

	async submit(text: string, spoken = false) {
		const trimmed = text.trim();
		if (!trimmed && !this.imageChip) return;
		const id = newId("p");
		this.#lastUserText = trimmed;
		this.eyes.touch();
		const now = await shell.nowLine().catch(() => undefined);
		const selection = this.selectionChip;
		const prompt = selection ? `${trimmed}\n\nSelected text:\n"""\n${selection}\n"""` : trimmed;
		const images = this.imageChip ? [this.imageChip] : undefined;
		this.selectionChip = null;
		this.imageChip = null;
		this.reply = { id, kind: "prompt", text: "", done: false, aborted: false, tools: [] };
		this.busy = true;
		this.eyes.setActivity("thinking");
		if (this.mode === "transcript") {
			this.transcript = [...this.transcript, { kind: "user", id: `local-${id}`, text: prompt, images: images?.length ?? 0, at: Date.now() }];
		}
		await shell.send({ type: "prompt", id, text: prompt, now, images, spoken });
	}

	async loadTranscript() {
		this.transcriptLoading = true;
		try {
			this.transcript = await shell.call<TranscriptItem[]>({ type: "transcript" });
		} catch {
			this.transcript = [];
		} finally {
			this.transcriptLoading = false;
		}
	}

	async clear() {
		if (this.busy) await shell.send({ type: "abort" });
		const { undoToken } = await shell.call<{ undoToken: string }>({ type: "clear" });
		this.reply = null;
		this.transcript = [];
		this.eyes.cleared();
		this.showToast("Context cleared", {
			label: "Undo",
			run: async () => {
				await shell.call({ type: "undo_clear", undoToken });
				this.toast = null;
			},
		});
	}

	async cycleThinking() {
		const levels = this.ready?.thinkingLevels ?? ["off", "low", "medium", "high", "max"];
		const next = levels[(levels.indexOf(this.thinking) + 1) % levels.length] ?? "medium";
		await shell.send({ type: "set_thinking", role: "main", level: next });
		if (this.settings?.main) {
			this.settings = await shell.settingsSet({ ...this.settings, main: { ...this.settings.main, thinking: next } });
		}
	}

	async undoMemory(saveId: string) {
		await shell.send({ type: "memory_undo", saveId });
	}

	showToast(text: string, action?: Toast["action"]) {
		clearTimeout(this.#toastTimer);
		this.toast = { text, action, until: Date.now() + UNDO_MS };
		this.#toastTimer = setTimeout(() => {
			this.toast = null;
		}, UNDO_MS);
	}

	async openSettings() {
		await shell.openWindow("settings");
	}

	// ── connect ──

	async connected(settings: Settings) {
		this.settings = settings;
		this.hasKey = await shell.secretPresent();
		this.focusTick += 1;
	}

	// ── incoming ──

	#onSettings(settings: Settings) {
		this.settings = settings;
		void shell.secretPresent().then((has) => {
			this.hasKey = has;
		});
	}

	#onUi(event: UiEvent) {
		switch (event.kind) {
			case "summon":
				void this.summon();
				break;
			case "hide":
				void this.hide();
				break;
			case "toggle_transcript":
				void this.toggleTranscript();
				break;
			case "ask_selection":
				this.selectionChip = event.text || null;
				void this.summon();
				break;
			case "attach_screenshot":
				this.imageChip = event.image;
				void this.summon();
				break;
			case "clear":
				void this.clear();
				break;
			case "cycle_thinking":
				void this.cycleThinking();
				break;
			case "action_started":
				if (event.output !== "replace") {
					this.reply = { id: `action-${event.slot}`, kind: "action", text: "", done: false, aborted: false, tools: [] };
					this.busy = true;
					void this.summon();
				}
				this.eyes.setActivity("thinking");
				break;
			case "talk_start":
				this.eyes.setActivity("listening");
				break;
			case "talk_end":
				if (event.text.trim()) void this.submit(event.text, true);
				else this.eyes.setActivity("idle");
				break;
			case "menu":
				break;
			case "update_ready":
				break;
		}
	}

	#onEngine(message: EngineMessage) {
		const reply = this.reply;
		switch (message.type) {
			case "ready":
				this.ready = {
					provider: message.provider,
					model: message.model,
					contextWindow: message.contextWindow,
					supportsImages: message.supportsImages,
					thinking: message.thinking,
					thinkingLevels: message.thinkingLevels,
				};
				break;
			case "thinking":
				this.busy = true;
				this.eyes.setActivity("thinking");
				break;
			case "text_delta":
				if (reply?.id === message.id) reply.text += message.delta;
				this.eyes.setActivity("speaking");
				break;
			case "tool_start":
				reply?.tools.push({ toolCallId: message.toolCallId, name: message.name, summary: message.summary, ok: null });
				this.eyes.setActivity("thinking");
				break;
			case "tool_end": {
				const tool = reply?.tools.find((t) => t.toolCallId === message.toolCallId);
				if (tool) {
					tool.ok = message.ok;
					tool.summary = message.summary || tool.summary;
				}
				break;
			}
			case "reply_end":
				if (reply?.id === message.id) {
					reply.text = message.text;
					reply.done = true;
					reply.aborted = message.aborted;
				}
				this.busy = false;
				if (message.aborted) this.eyes.setActivity("idle");
				else if (!reply?.error) this.eyes.replyFinished(message.mood, saysThanks(this.#lastUserText));
				if (this.mode === "transcript") void this.loadTranscript();
				break;
			case "action_delta":
				if (reply?.kind === "action") reply.text += message.delta;
				this.eyes.setActivity("speaking");
				break;
			case "action_end":
				if (reply?.kind === "action") {
					reply.text = message.text;
					reply.done = true;
					reply.aborted = message.aborted;
				}
				this.busy = false;
				this.eyes.replyFinished(undefined, false);
				break;
			case "context":
				this.contextPercent = message.percent;
				break;
			case "compaction_start":
				this.eyes.setActivity("thinking");
				this.eyes.yawn();
				break;
			case "compaction_end":
				if (!this.busy) this.eyes.setActivity("idle");
				if (this.mode === "transcript") void this.loadTranscript();
				break;
			case "thread_changed":
				if (message.reason !== "clear") {
					this.reply = null;
					this.eyes.cleared();
				}
				if (this.mode === "transcript") void this.loadTranscript();
				break;
			case "thinking_changed":
				if (message.role === "main" && this.ready) this.ready.thinking = message.level;
				break;
			case "memory_saved":
				this.eyes.noted();
				if (reply) reply.saved = [...(reply.saved ?? []), { saveId: message.saveId, title: message.title, undone: false }];
				break;
			case "memory_undone":
				for (const saved of reply?.saved ?? []) if (saved.saveId === message.saveId) saved.undone = true;
				break;
			case "error":
				this.eyes.error();
				if (reply && (!message.id || message.id === reply.id)) {
					reply.error = { kind: message.errorKind, message: message.message };
				} else {
					this.reply = {
						id: message.id ?? newId("err"),
						kind: "prompt",
						text: "",
						done: true,
						aborted: false,
						tools: [],
						error: { kind: message.errorKind, message: message.message },
					};
				}
				this.busy = false;
				break;
			default:
				break;
		}
	}
}
