// Typed wrappers for the shell's commands and events. See docs/ARCHITECTURE.md, "Shell ↔ UI contract".
// Outside Tauri (plain `vite` in a browser, used for UI work and screenshots) a mock shell is used.
import type {
	Command,
	Event as EngineEvent,
	ImageAttachment,
	NowLine,
	Request as EngineRequest,
	Response as EngineResponse,
} from "../../../../engine/src/protocol.ts";
import type { Settings } from "./settings.ts";

/** Credential Manager accounts: the provider key (default) and the Brave Search key. */
export type SecretAccount = "api-key" | "search-api-key";

export type WindowMode = "pill" | "bar" | "transcript";

export type MenuItem = "settings" | "history" | "ask_before_running" | "hide_eyes" | "pause_listening" | "quit";

export type UiEvent =
	| { kind: "summon" }
	| { kind: "hide" }
	| { kind: "toggle_transcript" }
	| { kind: "ask_selection"; text: string }
	| { kind: "attach_screenshot"; image: ImageAttachment }
	| { kind: "clear" }
	| { kind: "cycle_thinking" }
	/** An action hotkey captured a selection and sent run_action with this id. */
	| { kind: "action_started"; id: string; slot: number; name: string; output: "replace" | "show" | "agent" }
	/** An action hotkey couldn't run: nothing selected, or the paste-back failed. */
	| { kind: "action_error"; id?: string; slot: number; name: string; message: string }
	| { kind: "talk_start" }
	| { kind: "talk_level"; level: number }
	/** "" when nothing was heard. */
	| { kind: "talk_end"; text: string }
	/** Text-to-speech started (true) or finished or was stopped (false). */
	| { kind: "speech"; playing: boolean }
	/** The microphone, a model download or speech failed. */
	| { kind: "voice_error"; message: string }
	| { kind: "menu"; item: MenuItem }
	/** An update is downloaded (auto) or available (notify): the eyes show a small dot. */
	| { kind: "update_ready"; version: string }
	/** The pill moved across the screen: things now grow the other way. */
	| ({ kind: "layout" } & Layout);

/** Which way the bar and bubble grow from the pill: toward the middle of its monitor. */
export interface Layout {
	alignRight: boolean;
	above: boolean;
}

/** A shape the main window draws, logical px from the stage's top-left. */
export interface Shape {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type EngineMessage = EngineEvent | EngineRequest;
type Unlisten = () => void;

/** Commands that get a Result. The shell assigns the id. */
export type CallMessage = Command extends infer C ? (C extends { id: string } | { id?: string } ? Omit<C, "id"> : never) : never;

export interface ShellImpl {
	invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
	listen<T>(event: string, handler: (payload: T) => void): Promise<Unlisten>;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const impl: Promise<ShellImpl> = isTauri
	? Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]).then(([core, event]) => ({
			invoke: <T>(command: string, args?: Record<string, unknown>) => core.invoke<T>(command, args),
			listen: <T>(name: string, handler: (payload: T) => void) => event.listen<T>(name, ({ payload }) => handler(payload)),
		}))
	: import("./mock.ts").then((m) => m.createMockShell());

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
	return (await impl).invoke<T>(command, args);
}

async function listen<T>(event: string, handler: (payload: T) => void): Promise<Unlisten> {
	return (await impl).listen<T>(event, handler);
}

export interface HotkeyFailure {
	/** Settings field: "summon", "action1"…"action5", "askSelection", "screenshot", "clear", "cycleThinking" or "leaderKey". */
	name: string;
	binding: string;
	error: string;
}

export interface HotkeysStatus {
	failed: HotkeyFailure[];
}

export interface AltGrReport {
	/** null when the platform can't tell (non-Windows). */
	altGr: boolean | null;
	/** Keys that type a character with Ctrl+Alt in the current layout. */
	keys: string[];
	/** Settings fields of bindings that use Ctrl+Alt with one of those keys. */
	conflicts: string[];
	/** What to offer instead, "Ctrl+Shift". */
	suggestion: string;
}

export type VoiceModelId = "moonshine-base" | "whisper-base-en" | "parakeet" | "supertonic";

export interface VoiceModel {
	id: VoiceModelId;
	kind: "stt" | "tts";
	name: string;
	sizeMb: number;
	installed: boolean;
	downloading: boolean;
}

export interface OsVoice {
	id: string;
	name: string;
	language: string;
}

/** fraction 0…1 while downloading, 1 when installed, -1 when it failed. */
export interface DownloadProgress {
	what: "stt" | "tts";
	model: VoiceModelId;
	fraction: number;
}

export interface UpdateStatus {
	state: "idle" | "checking" | "available" | "downloading" | "ready" | "error";
	version?: string;
	notes?: string;
	error?: string;
}

export const shell = {
	send: (message: Command) => invoke<void>("engine_send", { message }),
	call: <T>(message: CallMessage) => invoke<T>("engine_call", { message }),
	respond: (response: EngineResponse) => invoke<void>("engine_respond", { response }),
	settingsGet: () => invoke<Settings>("settings_get"),
	settingsSet: (settings: Settings) => invoke<Settings>("settings_set", { settings }),
	secretSet: (apiKey: string, account?: SecretAccount) => invoke<void>("secret_set", { apiKey, account }),
	secretClear: (account?: SecretAccount) => invoke<void>("secret_clear", { account }),
	secretPresent: (account?: SecretAccount) => invoke<boolean>("secret_present", { account }),
	windowMode: (mode: WindowMode) => invoke<void>("window_mode", { mode }),
	/** The stage size and the shapes drawn on it (logical px). The window becomes the stage around
	 * the pill, clipped to the shapes on Windows. Returns which way things grow. */
	windowShape: (width: number, height: number, shapes: Shape[]) => invoke<Layout>("window_shape", { width, height, shapes }),
	windowLayout: () => invoke<Layout | null>("window_layout"),
	openWindow: (name: "settings" | "history") => invoke<void>("open_window", { name }),
	contextMenu: () => invoke<void>("context_menu"),
	hotkeysStatus: () => invoke<HotkeysStatus>("hotkeys_status"),
	hotkeysAltGr: () => invoke<AltGrReport>("hotkeys_altgr"),
	/** Open About me in the default editor, or the memory or voice folder. */
	openDataPath: (what: "about_me" | "memory" | "voice") => invoke<void>("open_data_path", { what }),
	nowLine: () => invoke<NowLine>("now_line"),
	screenshot: () => invoke<ImageAttachment>("screenshot"),
	/** Open an http(s) URL in the default browser. */
	openExternal: (url: string) => invoke<void>("open_external", { url }),
	speak: (text: string) => invoke<void>("speak", { text }),
	stopSpeaking: () => invoke<void>("stop_speaking"),
	updateStatus: () => invoke<UpdateStatus>("update_status"),
	updateCheck: () => invoke<UpdateStatus>("update_check"),
	/** Download if needed, install and relaunch. */
	updateRestart: () => invoke<void>("update_restart"),
	appVersion: async () => {
		if (!isTauri) return "0.0.1";
		const { getVersion } = await import("@tauri-apps/api/app");
		return getVersion();
	},
	voiceOsVoices: () => invoke<OsVoice[]>("voice_os_voices"),
	voiceModels: () => invoke<VoiceModel[]>("voice_models"),
	voiceModelDownload: (id: VoiceModelId) => invoke<void>("voice_model_download", { id }),
	voiceModelRemove: (id: VoiceModelId) => invoke<void>("voice_model_remove", { id }),
	/** Start dragging the current window (the resting pill). Needs core:window:allow-start-dragging. */
	startDrag: async () => {
		if (!isTauri) return;
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		await getCurrentWindow().startDragging();
	},
	/** Close the current window (Settings, History). */
	closeWindow: async () => {
		if (!isTauri) return window.close();
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		await getCurrentWindow().close();
	},
};

export const onEngine = (handler: (message: EngineMessage) => void) => listen<EngineMessage>("engine", handler);
export const onUi = (handler: (event: UiEvent) => void) => listen<UiEvent>("ui", handler);
export const onSettingsChanged = (handler: (settings: Settings) => void) => listen<Settings>("settings_changed", handler);

export const onDownloadProgress = (handler: (progress: DownloadProgress) => void) =>
	listen<DownloadProgress>("download_progress", handler);

export const onUpdateStatus = (handler: (status: UpdateStatus) => void) => listen<UpdateStatus>("update_status", handler);

export const onHotkeysStatus = (handler: (status: HotkeysStatus) => void) => listen<HotkeysStatus>("hotkeys_status", handler);

let nextId = 0;
/** Unique id for prompts and actions sent from this window. */
export function newId(prefix: string): string {
	nextId += 1;
	return `${prefix}-${Date.now().toString(36)}-${nextId}`;
}
