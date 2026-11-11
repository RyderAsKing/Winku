// The main window's interaction state: pill ↔ bar ↔ transcript, the current reply, chips,
// toasts and the eyes. Engine events and shell `ui` events come in here; components render it.
import type {
	ErrorKind,
	ImageAttachment,
	ThinkingLevel,
	TranscriptItem,
} from "../../../../engine/src/protocol.ts";
import { EyeController } from "../lib/eyes/controller.svelte.ts";
import { lidFor, saysThanks, TINTS } from "../lib/eyes/look.ts";
import type { Settings } from "../lib/settings.ts";
import {
	type DownloadProgress,
	type EngineMessage,
	newId,
	onDownloadProgress,
	onEngine,
	onSettingsChanged,
	onUi,
	shell,
	type UiEvent,
	type WindowMode,
} from "../lib/shell.ts";
import { shouldSpeak, speakable } from "../lib/speech.ts";

export interface LiveTool {
	toolCallId: string;
	name: string;
	summary: string;
	ok: boolean | null;
}

export interface Reply {
	id: string;
	kind: "prompt" | "action";
	/** The action's name, for action replies. */
	title?: string;
	text: string;
	done: boolean;
	aborted: boolean;
	tools: LiveTool[];
	error?: { kind: ErrorKind | "action" | "voice"; message: string };
	saved?: { saveId: string; title: string; undone: boolean }[];
	proposals?: VoiceProposal[];
	permissions?: PermissionAsk[];
}

/** "Ask before running": a tool call waiting for the user (SPEC §7). */
export interface PermissionAsk {
	requestId: string;
	tool: string;
	summary: string;
	allowKey: string;
	decided?: Decision;
}

export type Decision = "allow_once" | "always" | "deny";

export interface VoiceProposal {
	proposalId: string;
	profile: string;
	content: string;
	current: string;
	reason: string;
	decided?: "accepted" | "dismissed";
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
	/** The talk key is held and the microphone is open. */
	listening = $state(false);
	/** Microphone level while listening, 0…1. */
	talkLevel = $state(0);
	/** Text-to-speech is playing. */
	speaking = $state(false);
	/** A voice model downloading (SPEC §3: progress shows on the eyes). */
	download: DownloadProgress | null = $state(null);
	/** Version of an update that is downloaded or available; the eyes show a dot. */
	updateReady: string | null = $state(null);

	readonly needsConnect: boolean = $derived(
		this.settings !== null &&
			(!this.settings.provider ||
				!this.settings.main ||
				(this.settings.provider.kind === "catalog" && !this.hasKey)),
	);
	readonly thinking: ThinkingLevel = $derived(this.ready?.thinking ?? this.settings?.main?.thinking ?? "medium");
	readonly tint: string = $derived(TINTS[this.thinking]);
	readonly lid: number = $derived(lidFor(this.contextPercent));

	#lastUserText = "";
	/** Replace actions in flight: their text is pasted by the shell, not shown. */
	readonly #replaceActions = new Set<string>();
	readonly #replaceResults = new Map<string, string>();
	#toastTimer: ReturnType<typeof setTimeout> | undefined;
	/** Prompt ids the user spoke, for mirror mode. */
	readonly #spokenPrompts = new Set<string>();

	async init() {
		await Promise.all([
			onEngine((m) => this.#onEngine(m)),
			onUi((e) => this.#onUi(e)),
			onSettingsChanged((s) => this.#onSettings(s)),
			onDownloadProgress((p) => this.#onDownload(p)),
		]);
		const [settings, hasKey] = await Promise.all([shell.settingsGet(), shell.secretPresent()]);
		void shell
			.updateStatus()
			.then((s) => {
				if ((s.state === "ready" || s.state === "available") && s.version) this.updateReady = s.version;
			})
			.catch(() => {});
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

	/** Esc: first press stops the reply or the speech, a second press hides the bar (SPEC §5). */
	async escape() {
		if (this.busy || this.speaking) {
			if (this.busy) await shell.send({ type: "abort" });
			await this.stopSpeaking();
			return;
		}
		await this.hide();
	}

	async stopSpeaking() {
		this.speaking = false;
		if (this.eyes.activity === "speaking" && !this.busy) this.eyes.setActivity("idle");
		await shell.stopSpeaking().catch(() => {});
	}

	// ── conversation ──

	async submit(text: string, spoken = false) {
		const trimmed = text.trim();
		if (!trimmed && !this.imageChip) return;
		const id = newId("p");
		if (spoken) this.#spokenPrompts.add(id);
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
			this.transcript = [...this.transcript, { kind: "user", id: `local-${id}`, text: prompt, images: images?.length ?? 0, ...(spoken ? { spoken } : {}), at: Date.now() }];
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

	/** Answer a permission request. "Always" also remembers the command in settings. */
	async decidePermission(ask: PermissionAsk, decision: Decision) {
		ask.decided = decision;
		await shell.respond({ type: "response", id: ask.requestId, ok: true, data: { decision } });
		if (decision === "always" && this.settings && !this.settings.alwaysAllow.includes(ask.allowKey)) {
			this.settings = await shell.settingsSet({ ...this.settings, alwaysAllow: [...this.settings.alwaysAllow, ask.allowKey] });
		}
	}

	/** Accept or dismiss a proposed change to a voice profile (SPEC §9). */
	async decideProposal(proposal: VoiceProposal, accept: boolean) {
		await shell.call({ type: "voice_proposal_decision", proposalId: proposal.proposalId, accept });
		proposal.decided = accept ? "accepted" : "dismissed";
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
				this.eyes.touch();
				this.eyes.setActivity("thinking");
				if (event.output === "replace") {
					// Pasted straight back into the app; the bar stays closed (SPEC §6).
					this.#replaceActions.add(event.id);
				} else {
					this.reply = {
						id: event.id,
						kind: event.output === "show" ? "action" : "prompt",
						title: event.name,
						text: "",
						done: false,
						aborted: false,
						tools: [],
					};
					this.busy = true;
					void this.summon();
				}
				break;
			case "action_error": {
				// Nothing selected, or the paste failed: then show the result here instead.
				const text = (event.id && this.#replaceResults.get(event.id)) || "";
				if (event.id) {
					this.#replaceActions.delete(event.id);
					this.#replaceResults.delete(event.id);
				}
				this.eyes.error();
				this.reply = {
					id: event.id ?? newId("action-error"),
					kind: "action",
					title: event.name,
					text,
					done: true,
					aborted: false,
					tools: [],
					error: { kind: "action", message: event.message },
				};
				this.busy = false;
				void this.summon();
				break;
			}
			case "talk_start":
				// The shell has already stopped any speech.
				this.speaking = false;
				this.listening = true;
				this.talkLevel = 0;
				this.eyes.setActivity("listening");
				break;
			case "talk_level":
				this.talkLevel = event.level;
				break;
			case "talk_end":
				this.listening = false;
				if (event.text.trim()) {
					// The shell notes the window in front as the bar opens, for the now line.
					void this.summon().then(() => this.submit(event.text, true));
				} else if (this.eyes.activity === "listening") this.eyes.setActivity("idle");
				break;
			case "speech":
				this.speaking = event.playing;
				if (event.playing) this.eyes.setActivity("speaking");
				else if (this.eyes.activity === "speaking" && !this.busy) this.eyes.setActivity("idle");
				break;
			case "voice_error":
				this.listening = false;
				this.speaking = false;
				if (!this.busy) {
					this.reply = {
						id: newId("voice"),
						kind: "prompt",
						text: "",
						done: true,
						aborted: false,
						tools: [],
						error: { kind: "voice", message: event.message },
					};
					void this.summon();
				}
				this.eyes.error();
				break;
			case "menu":
				break;
			case "update_ready":
				this.updateReady = event.version;
				break;
		}
	}

	/** Mirror mode and friends (SPEC §11): read a finished reply aloud. */
	#speakReply(id: string, text: string, failed: boolean) {
		const spoken = this.#spokenPrompts.delete(id);
		const mode = this.settings?.voice.reply ?? "mirror";
		if (failed || !shouldSpeak(mode, spoken)) return;
		const words = speakable(text);
		if (words) void shell.speak(words).catch(() => {});
	}

	#onDownload(progress: DownloadProgress) {
		if (progress.fraction >= 1 || progress.fraction < 0) {
			if (this.download?.model === progress.model) this.download = null;
			return;
		}
		this.download = progress;
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
				// A memory save shows as its own "Saved to memory" row instead.
				if (message.name === "memory_save") break;
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
				this.#speakReply(message.id, message.text, message.aborted || Boolean(reply?.error));
				if (this.mode === "transcript") void this.loadTranscript();
				break;
			case "action_delta":
				if (reply?.id === message.id) reply.text += message.delta;
				if (!this.#replaceActions.has(message.id)) this.eyes.setActivity("speaking");
				break;
			case "action_end":
				if (this.#replaceActions.delete(message.id)) {
					// The shell pastes the text; only the eyes react. A failed paste comes as
					// action_error, so keep the text briefly to show it then.
					if (message.aborted) this.eyes.setActivity("idle");
					else {
						this.eyes.replyFinished(undefined, false);
						this.#replaceResults.set(message.id, message.text);
						setTimeout(() => this.#replaceResults.delete(message.id), 10_000);
					}
					break;
				}
				if (reply?.id === message.id) {
					reply.text = message.text;
					reply.done = true;
					reply.aborted = message.aborted;
				}
				this.busy = false;
				if (message.aborted) {
					if (!reply?.error) this.eyes.setActivity("idle");
				} else this.eyes.replyFinished(undefined, false);
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
			case "request":
				if (message.method === "permission") {
					const ask: PermissionAsk = {
						requestId: message.id,
						tool: message.params.tool,
						summary: message.params.summary,
						allowKey: message.params.allowKey,
					};
					const target = reply && (!message.params.replyId || message.params.replyId === reply.id) ? reply : null;
					if (target) target.permissions = [...(target.permissions ?? []), ask];
					else {
						this.reply = { id: message.params.replyId ?? newId("ask"), kind: "prompt", text: "", done: false, aborted: false, tools: [], permissions: [ask] };
					}
					void this.summon();
				}
				break;
			case "voice_proposal": {
				const proposal: VoiceProposal = {
					proposalId: message.proposalId,
					profile: message.profile,
					content: message.content,
					current: message.current,
					reason: message.reason,
				};
				if (reply) reply.proposals = [...(reply.proposals ?? []), proposal];
				break;
			}
			case "memory_undone":
				for (const saved of reply?.saved ?? []) if (saved.saveId === message.saveId) saved.undone = true;
				break;
			case "error":
				this.eyes.error();
				// A replace action failed: open the bar so the error is seen.
				if (message.id && this.#replaceActions.delete(message.id)) {
					this.reply = {
						id: message.id,
						kind: "action",
						text: "",
						done: true,
						aborted: false,
						tools: [],
						error: { kind: message.errorKind, message: message.message },
					};
					void this.summon();
					break;
				}
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
