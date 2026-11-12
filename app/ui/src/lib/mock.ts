// Browser-only stand-in for the Tauri shell and engine, for UI work and screenshots.
// Loaded by shell.ts when the page is not running inside Tauri. URL parameters pick a scenario:
//   ?connect=1     no provider yet (Connect form)
//   ?ctx=0.62      context fullness
//   ?thinking=high Main thinking level
//   ?altgr=1       the keyboard layout has AltGr (Settings offers Ctrl+Shift)
//   ?taken=action2 a hotkey another app already registered
//   ?long=1        transcript with long paths, unbroken text, code and a table
//   ?many=1        forty extra archived conversations
//   ?empty=1       no History entries
import type { Command, HistoryEntry, ModelInfo, ProviderInfo, ThinkingLevel, TranscriptItem } from "../../../../engine/src/protocol.ts";
import { defaultSettings } from "./defaults.ts";
import type { Settings } from "./settings.ts";
import type { ShellImpl } from "./shell.ts";

type Handler = (payload: unknown) => void;

const params = new URLSearchParams(location.search);
const now = Date.UTC(2026, 10, 11, 12);

const SAMPLE_TRANSCRIPT: TranscriptItem[] = [
	{ kind: "compaction", id: "c1", summary: "You planned a trip to Lisbon and asked for packing lists. We settled on carry-on only.", at: now - 3_600_000 },
	{ kind: "user", id: "u1", text: "What's the quickest way to convert a PNG folder to WebP on Windows?", images: 0, at: now - 600_000 },
	{
		kind: "tool",
		id: "t1",
		name: "powershell",
		summary: "Get-Command cwebp",
		ok: true,
		detail: "CommandType Name  Version\n----------- ----  -------\nApplication cwebp.exe 1.4.0",
		at: now - 590_000,
	},
	{
		kind: "assistant",
		id: "a1",
		text: "You already have `cwebp`. From the folder, run:\n\n```powershell\nGet-ChildItem *.png | ForEach-Object { cwebp -q 82 $_ -o ($_.BaseName + '.webp') }\n```\n\nQuality 82 keeps text sharp at about a third of the size.",
		mood: "happy",
		at: now - 580_000,
	},
	{ kind: "memory_saved", id: "m1", saveId: "s1", title: "Prefers WebP at quality 82 for screenshots", undone: false, at: now - 570_000 },
	{ kind: "user", id: "u2", text: "thanks!", images: 0, at: now - 60_000 },
	{ kind: "assistant", id: "a2", text: "Any time.", mood: "hearts", at: now - 58_000 },
];

const SAMPLE_HISTORY: HistoryEntry[] = [
	{ id: "cur", kind: "thread", title: "What's the quickest way to convert a PNG folder to WebP on Windows?", startedAt: now - 3_700_000, updatedAt: now - 58_000, messageCount: 6, current: true },
	{ id: "act1", kind: "action", title: "Fix grammar: Thanks for the quick turnaround, I'll loop in…", startedAt: now - 7_200_000, updatedAt: now - 7_200_000, messageCount: 2, current: false },
	{ id: "old1", kind: "thread", title: "Draft a polite reply declining the Thursday meeting", startedAt: now - 86_400_000, updatedAt: now - 85_000_000, messageCount: 8, current: false },
	{ id: "old2", kind: "thread", title: "Why does my laptop fan spin up when the lid is closed?", startedAt: now - 3 * 86_400_000, updatedAt: now - 3 * 86_400_000, messageCount: 12, current: false },
];

const PROVIDERS: ProviderInfo[] = [
	{ id: "anthropic", name: "Anthropic", keyUrl: "https://console.anthropic.com/settings/keys" },
	{ id: "openai", name: "OpenAI", keyUrl: "https://platform.openai.com/api-keys" },
	{ id: "google", name: "Google Gemini", keyUrl: "https://aistudio.google.com/apikey" },
	{ id: "openrouter", name: "OpenRouter", keyUrl: "https://openrouter.ai/keys" },
	{ id: "groq", name: "Groq" },
	{ id: "mistral", name: "Mistral" },
];

const MODELS: ModelInfo[] = [
	{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", supportsImages: true, contextWindow: 200_000, thinkingLevels: ["off", "low", "medium", "high", "max"] },
	{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", supportsImages: true, contextWindow: 200_000, thinkingLevels: ["off", "low", "medium", "high"] },
	{ id: "claude-opus-4-1", name: "Claude Opus 4.1", supportsImages: true, contextWindow: 200_000, thinkingLevels: ["off", "low", "medium", "high", "max"] },
];

const LONG_REPLY = `## Files ready for review

Here is a long path: C:\\Users\\Sam\\Documents\\${"project-with-a-long-name".repeat(12)}.md

[Read the reference](https://example.com/${"reference".repeat(30)})

${"Unbroken".repeat(45)}

\`\`\`typescript
const path = "${"long-path/".repeat(35)}";
\`\`\`

| File | Result |
| --- | --- |
| ${"filename".repeat(30)} | Ready |

All files are ready. Review the changes before continuing.`;

const EXPLAIN =
	"**Idempotent** means doing it twice has the same effect as doing it once.\n\n- Setting a light switch to *on* is idempotent.\n- Flipping it is not: the second flip undoes the first.";

/** What the mock says aloud for REPLY when the prompt asks for speech. */
const SAID = "Press Windows, Shift and S, then drag over the part you want. It lands on your clipboard.";

const REPLY =
	"Sure. Press **Win+Shift+S**, drag over the area, and the capture lands on your clipboard. Paste it into Paint or any chat window to save or share it.";

export function createMockShell(): ShellImpl {
	const handlers = new Map<string, Set<Handler>>();
	const emit = (event: string, payload: unknown) => {
		for (const h of handlers.get(event) ?? []) h(payload);
	};

	let settings: Settings = defaultSettings();
	const size = params.get("size");
	if (size === "medium" || size === "large") settings = { ...settings, eyes: { ...settings.eyes, size } };
	// ?left puts the pill on the left half of the screen, ?low in the lower part.
	const layout = { alignRight: !params.has("left"), above: params.has("low") };
	let hasKey = !params.has("connect");
	let hasSearchKey = false;
	let pendingAsk: ((decision: string) => void) | null = null;
	if (hasKey) {
		settings = {
			...settings,
			voiceProfiles: { default: "casual", byApp: { "outlook.exe": "work" } },
			askBeforeRunning: params.has("ask"),
			alwaysAllow: params.has("ask") ? ["powershell:Get-ChildItem", "open:https://github.com"] : [],
			provider: { kind: "catalog", id: "anthropic" },
			main: { id: "claude-sonnet-4-5", thinking: (params.get("thinking") as ThinkingLevel | null) ?? "medium" },
		};
	}
	const ctx = Number(params.get("ctx") ?? "0.23");
	let timers: ReturnType<typeof setTimeout>[] = [];
	let streaming: string | null = null;

	const ready = () => {
		if (!settings.provider || !settings.main) return;
		emit("engine", {
			type: "ready",
			provider: "anthropic",
			model: settings.main.id,
			contextWindow: 200_000,
			supportsImages: true,
			thinking: settings.main.thinking,
			thinkingLevels: ["off", "low", "medium", "high", "max"],
		});
		emit("engine", { type: "context", tokens: Math.round(ctx * 200_000), contextWindow: 200_000, percent: ctx * 100 });
	};

	const stream = (id: string, speak: boolean) => {
		timers.forEach(clearTimeout);
		timers = [];
		streaming = id;
		emit("engine", { type: "thinking", id });
		const words = REPLY.split(/(?<= )/);
		let t = 900;
		// Like the engine for a spoken reply: the <say> block comes first, then the written part.
		if (speak) {
			timers.push(setTimeout(() => emit("engine", { type: "say", id, text: SAID }), t));
			t += 500;
		}
		for (const word of words) {
			timers.push(setTimeout(() => emit("engine", { type: "text_delta", id, delta: word }), t));
			t += 45;
		}
		timers.push(
			setTimeout(() => {
				streaming = null;
				emit("engine", { type: "reply_end", id, text: REPLY, aborted: false, mood: "happy" });
				emit("engine", { type: "context", tokens: Math.round((ctx + 0.01) * 200_000), contextWindow: 200_000, percent: (ctx + 0.01) * 100 });
			}, t + 100),
		);
	};

	const handleSend = (message: Command) => {
		if (message.type === "prompt") {
			if (/\bremember\b/i.test(message.text)) memoryReply(message.id);
			else if (/\bclean up\b/i.test(message.text)) askReply(message.id);
			else stream(message.id, Boolean(message.speak));
		}
		if (message.type === "abort" && streaming) {
			timers.forEach(clearTimeout);
			timers = [];
			// Like the engine: an aborted reply still ends with reply_end.
			emit("engine", { type: "reply_end", id: streaming, text: "", aborted: true });
			streaming = null;
		}
		if (message.type === "set_thinking") {
			emit("engine", { type: "thinking_changed", role: message.role, level: message.level });
		}
	};

	const handleCall = (message: Command): unknown => {
		switch (message.type) {
			case "transcript":
				return params.has("long") ? [...SAMPLE_TRANSCRIPT, { kind: "assistant", id: "long", text: LONG_REPLY, at: now }] : SAMPLE_TRANSCRIPT;
			case "history_list":
				return (params.has("empty") ? [] : params.has("many") ? [...SAMPLE_HISTORY, ...Array.from({ length: 40 }, (_, i) => ({ ...SAMPLE_HISTORY[2], id: `archive-${i}`, title: `Archive ${i + 1}: ${"LongProjectPath".repeat(12)}`, updatedAt: now - (i + 4) * 86400000 }))] : SAMPLE_HISTORY).filter((h) => !message.query || h.title.toLowerCase().includes(message.query.toLowerCase()));
			case "history_read":
				return params.has("long") ? [...SAMPLE_TRANSCRIPT, { kind: "assistant", id: "long", text: LONG_REPLY, at: now }] : SAMPLE_TRANSCRIPT;
			case "clear":
				setTimeout(() => emit("engine", { type: "thread_changed", reason: "clear", sessionId: "new" }), 10);
				return { undoToken: "undo-1" };
			case "list_providers":
				return PROVIDERS;
			case "list_models":
				return MODELS;
			case "test_connection":
				return { ok: true, supportsImages: true };
			case "voice_list":
				return [
					{ name: "casual", summary: "Casual: short, warm, lowercase is fine" },
					{ name: "work", summary: "Work: clear, polite, no slang" },
				];
			case "memory_forget_all":
				return { removed: 4 };
			case "voice_proposal_decision":
				return { written: message.accept };
			default:
				return undefined;
		}
	};

	/** A reply that saves a memory and proposes a voice change ("remember …" prompts). */
	const memoryReply = (id: string) => {
		emit("engine", { type: "thinking", id });
		timers.push(
			setTimeout(() => {
				emit("engine", { type: "memory_saved", id, saveId: "s-1", title: "Signs off work emails with “Cheers, Sam”" });
				emit("engine", {
					type: "voice_proposal",
					id,
					proposalId: "v-1",
					profile: "work",
					current: "# Work\n- Clear and polite.\n- No slang.",
					content: "# Work\n- Clear and polite.\n- No slang.\n- Sign off with “Cheers, Sam”.",
					reason: "add your sign-off.",
				});
				const text = "Noted. Want me to add it to your work voice too?";
				emit("engine", { type: "text_delta", id, delta: text });
				emit("engine", { type: "reply_end", id, text, aborted: false, mood: "happy" });
			}, 600),
		);
	};

	/** "Ask before running": a tool call that waits for Allow / Deny ("clean up" prompts). */
	const askReply = (id: string) => {
		emit("engine", { type: "thinking", id });
		const toolCallId = "t-ask";
		const summary = "Remove-Item $HOME\\Downloads\\*.tmp";
		timers.push(
			setTimeout(() => {
				emit("engine", { type: "tool_start", id, toolCallId, name: "powershell", summary });
				emit("engine", {
					type: "request",
					id: "r-ask",
					method: "permission",
					params: { replyId: id, tool: "powershell", summary: `Run: ${summary}`, allowKey: "powershell:Remove-Item" },
				});
				pendingAsk = (decision) => {
					pendingAsk = null;
					const ok = decision !== "deny";
					emit("engine", { type: "tool_end", id, toolCallId, ok, summary });
					const text = ok ? "Done. I removed 14 temporary files from Downloads." : "Okay, I left them alone.";
					emit("engine", { type: "text_delta", id, delta: text });
					emit("engine", { type: "reply_end", id, text, aborted: false, mood: ok ? "happy" : "neutral" });
				};
			}, 500),
		);
	};

	/** What the shell does for an action hotkey (SPEC §6), with a canned result. */
	let actionCount = 0;
	const action = (slot: number, selection = "idempotent") => {
		const spec = settings.actions[slot - 1];
		if (!spec) return;
		if (!selection) {
			emit("ui", { kind: "action_error", slot, name: spec.name, message: "Select some text first" });
			return;
		}
		actionCount += 1;
		const id = `action-${actionCount}`;
		emit("ui", { kind: "action_started", id, slot, name: spec.name, output: spec.output });
		if (spec.output === "agent") return stream(id, false);
		const words = EXPLAIN.split(/(?<= )/);
		let t = 700;
		for (const word of words) {
			timers.push(setTimeout(() => emit("engine", { type: "action_delta", id, delta: word }), t));
			t += 35;
		}
		timers.push(
			setTimeout(() => emit("engine", { type: "action_end", id, text: EXPLAIN, output: spec.output, aborted: false }), t + 50),
		);
	};

	// Voice: models, a fake download, and speech that "plays" for a moment.
	const models = [
		{ id: "moonshine-base", kind: "stt", name: "Moonshine base (English)", sizeMb: 111, installed: params.has("voice") },
		{ id: "whisper-base-en", kind: "stt", name: "Whisper base.en", sizeMb: 209, installed: false },
		{ id: "parakeet", kind: "stt", name: "Parakeet TDT 0.6B v2 (English)", sizeMb: 482, installed: false },
		{ id: "supertonic", kind: "tts", name: "Supertonic (English)", sizeMb: 85, installed: false },
	];
	const downloading = new Set<string>();
	const download = (id: string) => {
		const model = models.find((m) => m.id === id);
		if (!model || model.installed || downloading.has(id)) return;
		downloading.add(id);
		const what = model.kind;
		for (let step = 0; step <= 20; step++) {
			timers.push(
				setTimeout(() => {
					if (step === 20) {
						downloading.delete(id);
						model.installed = true;
					}
					emit("download_progress", { what, model: id, fraction: step / 20 });
				}, step * 150),
			);
		}
	};
	let speechTimer: ReturnType<typeof setTimeout> | undefined;
	let speechEnds = 0;
	const speechLeft = () => Math.max(0, speechEnds - Date.now());
	/** Stops the pretend speech; `quietly` (an append taking over) sends no playing: false. */
	const stopSpeech = (quietly = false) => {
		if (speechTimer === undefined) return;
		clearTimeout(speechTimer);
		speechTimer = undefined;
		if (!quietly) emit("ui", { kind: "speech", playing: false });
	};
	/** Hold-to-talk by hand: talk_start, a few levels, then talk_end with `text` after `ms` (or never, if ms < 0). */
	const talk = (text: string, ms = 1200) => {
		stopSpeech();
		emit("ui", { kind: "talk_start" });
		if (params.has("download")) emit("download_progress", { what: "stt", model: "moonshine-base", fraction: 0.42 });
		if (ms < 0) return;
		for (let t = 100; t < ms; t += 100) timers.push(setTimeout(() => emit("ui", { kind: "talk_level", level: 0.3 + 0.4 * Math.abs(Math.sin(t)) }), t));
		// The words so far, a few more each time, as the shell sends them while recording.
		const words = text.split(" ");
		for (let n = 2; n < words.length; n += 2) {
			timers.push(setTimeout(() => emit("ui", { kind: "talk_partial", text: words.slice(0, n).join(" ") }), (ms * n) / words.length));
		}
		timers.push(setTimeout(() => emit("ui", { kind: "talk_end", text }), ms));
	};

	// The shell's hotkey hints, in the browser: Ctrl+Alt held on its own for 450 ms.
	let hintTimer: ReturnType<typeof setTimeout> | undefined;
	let hintShown = false;
	const endHint = () => {
		clearTimeout(hintTimer);
		hintTimer = undefined;
		if (hintShown) emit("ui", { kind: "hotkey_hint", show: false });
		hintShown = false;
	};
	window.addEventListener("keydown", (e) => {
		const prefixOnly = e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && (e.key === "Control" || e.key === "Alt");
		if (!prefixOnly) return endHint();
		if (hintTimer === undefined && !hintShown) {
			hintTimer = setTimeout(() => {
				hintShown = true;
				emit("ui", { kind: "hotkey_hint", show: true });
			}, 450);
		}
	});
	window.addEventListener("keyup", endHint);
	window.addEventListener("blur", endHint);

	// Hooks for the screenshot script: fire shell `ui` events or engine events by hand.
	(window as unknown as { __winkuMock: unknown }).__winkuMock = {
		ui: (event: unknown) => emit("ui", event),
		engine: (event: unknown) => emit("engine", event),
		action,
		talk,
	};

	return {
		async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
			const message = args?.message as Command | undefined;
			switch (command) {
				case "engine_send":
					if (message) handleSend(message);
					return undefined as T;
				case "engine_call":
					await new Promise((r) => setTimeout(r, 120));
					return (message ? handleCall(message) : undefined) as T;
				case "settings_get":
					return structuredClone(settings) as T;
				case "settings_set":
					settings = structuredClone(args?.settings as Settings);
					emit("settings_changed", settings);
					setTimeout(ready, 50);
					return structuredClone(settings) as T;
				case "secret_present":
					return (args?.account === "search-api-key" ? hasSearchKey : hasKey) as T;
				case "secret_set":
					if (args?.account === "search-api-key") hasSearchKey = true;
					else hasKey = true;
					return undefined as T;
				case "secret_clear":
					if (args?.account === "search-api-key") hasSearchKey = false;
					else hasKey = false;
					return undefined as T;
				case "engine_respond": {
					const response = args?.response as { id: string; data?: { decision?: string } } | undefined;
					if (response) pendingAsk?.(response.data?.decision ?? "deny");
					return undefined as T;
				}
				case "hotkeys_status": {
					const taken = params.get("taken");
					const binding = taken?.startsWith("action") ? settings.hotkeys.actions[Number(taken.slice(6)) - 1] : undefined;
					return { failed: taken ? [{ name: taken, binding: binding ?? "", error: "already registered" }] : [] } as T;
				}
				case "hotkeys_altgr": {
					const altGr = params.has("altgr");
					const conflicts = altGr
						? ["summon", "askSelection", "screenshot", "clear", "cycleThinking"].filter((k) =>
								/^ctrl\+alt\+/i.test(settings.hotkeys[k as "summon"]),
							)
						: [];
					return { altGr, keys: altGr ? ["Q", "E", "2", "3"] : [], conflicts, suggestion: "Ctrl+Shift" } as T;
				}
				case "update_status":
					return (params.has("update") ? { state: "ready", version: "0.2.0" } : { state: "idle" }) as T;
				case "update_check":
					await new Promise((r) => setTimeout(r, 600));
					return { state: "idle" } as T;
				case "update_restart":
					return undefined as T;
				case "voice_models":
					return models.map((m) => ({ ...m, downloading: downloading.has(m.id) })) as T;
				case "voice_os_voices":
					return [
						{ id: "MSTTS_V110_enUS_DavidM", name: "Microsoft David", language: "en-US" },
						{ id: "MSTTS_V110_enUS_ZiraM", name: "Microsoft Zira", language: "en-US" },
						{ id: "MSTTS_V110_enGB_HazelM", name: "Microsoft Hazel", language: "en-GB" },
					] as T;
				case "voice_model_download":
					download(String(args?.id));
					return undefined as T;
				case "voice_model_remove": {
					const model = models.find((m) => m.id === args?.id);
					if (model) model.installed = false;
					return undefined as T;
				}
				case "speak": {
					const words = String(args?.text ?? "").split(/\s+/).length;
					const append = Boolean(args?.append) && speechTimer !== undefined;
					const extra = append ? speechLeft() : 0;
					stopSpeech(append);
					if (!append) emit("ui", { kind: "speech", playing: true });
					speechEnds = Date.now() + extra + Math.min(8000, 400 + words * 280);
					speechTimer = setTimeout(() => {
						speechTimer = undefined;
						emit("ui", { kind: "speech", playing: false });
					}, speechEnds - Date.now());
					return undefined as T;
				}
				case "stop_speaking":
					stopSpeech();
					return undefined as T;
				case "now_line":
					return { app: "Code.exe", windowTitle: "main.rs - winku" } as T;
				case "window_layout":
				case "window_shape":
					return layout as T;
				default:
					return undefined as T;
			}
		},
		async listen<T>(event: string, handler: (payload: T) => void) {
			const set = handlers.get(event) ?? new Set();
			set.add(handler as Handler);
			handlers.set(event, set);
			if (event === "engine") setTimeout(ready, 30);
			return () => set.delete(handler as Handler);
		},
	};
}
