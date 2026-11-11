// Browser-only stand-in for the Tauri shell and engine, for UI work and screenshots.
// Loaded by shell.ts when the page is not running inside Tauri. URL parameters pick a scenario:
//   ?connect=1     no provider yet (Connect form)
//   ?ctx=0.62      context fullness
//   ?thinking=high Main thinking level
//   ?altgr=1       the keyboard layout has AltGr (Settings offers Ctrl+Shift)
//   ?taken=action2 a hotkey another app already registered
import type { Command, HistoryEntry, ModelInfo, ProviderInfo, ThinkingLevel, TranscriptItem } from "../../../../engine/src/protocol.ts";
import { defaultSettings } from "./defaults.ts";
import type { Settings } from "./settings.ts";
import type { ShellImpl } from "./shell.ts";

type Handler = (payload: unknown) => void;

const params = new URLSearchParams(location.search);
const now = Date.now();

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

const REPLY =
	"Sure. Press **Win+Shift+S**, drag over the area, and the capture lands on your clipboard. Paste it into Paint or any chat window to save or share it.";

export function createMockShell(): ShellImpl {
	const handlers = new Map<string, Set<Handler>>();
	const emit = (event: string, payload: unknown) => {
		for (const h of handlers.get(event) ?? []) h(payload);
	};

	let settings: Settings = defaultSettings();
	let hasKey = !params.has("connect");
	if (hasKey) {
		settings = {
			...settings,
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

	const stream = (id: string) => {
		timers.forEach(clearTimeout);
		timers = [];
		streaming = id;
		emit("engine", { type: "thinking", id });
		const words = REPLY.split(/(?<= )/);
		let t = 900;
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
		if (message.type === "prompt") stream(message.id);
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
				return SAMPLE_TRANSCRIPT;
			case "history_list":
				return SAMPLE_HISTORY.filter((h) => !message.query || h.title.toLowerCase().includes(message.query.toLowerCase()));
			case "history_read":
				return SAMPLE_TRANSCRIPT;
			case "clear":
				setTimeout(() => emit("engine", { type: "thread_changed", reason: "clear", sessionId: "new" }), 10);
				return { undoToken: "undo-1" };
			case "list_providers":
				return PROVIDERS;
			case "list_models":
				return MODELS;
			case "test_connection":
				return { ok: true, supportsImages: true };
			default:
				return undefined;
		}
	};

	// Hooks for the screenshot script: fire shell `ui` events or engine events by hand.
	(window as unknown as { __winkuMock: unknown }).__winkuMock = {
		ui: (event: unknown) => emit("ui", event),
		engine: (event: unknown) => emit("engine", event),
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
					return hasKey as T;
				case "secret_set":
					hasKey = true;
					return undefined as T;
				case "secret_clear":
					hasKey = false;
					return undefined as T;
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
				case "now_line":
					return { app: "Code.exe", windowTitle: "main.rs - winku" } as T;
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
