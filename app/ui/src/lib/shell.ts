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
	| { kind: "talk_end"; text: string }
	| { kind: "menu"; item: MenuItem }
	| { kind: "update_ready" };

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

export const shell = {
	send: (message: Command) => invoke<void>("engine_send", { message }),
	call: <T>(message: CallMessage) => invoke<T>("engine_call", { message }),
	respond: (response: EngineResponse) => invoke<void>("engine_respond", { response }),
	settingsGet: () => invoke<Settings>("settings_get"),
	settingsSet: (settings: Settings) => invoke<Settings>("settings_set", { settings }),
	secretSet: (apiKey: string) => invoke<void>("secret_set", { apiKey }),
	secretClear: () => invoke<void>("secret_clear"),
	secretPresent: () => invoke<boolean>("secret_present"),
	windowMode: (mode: WindowMode) => invoke<void>("window_mode", { mode }),
	/** Whole bar height in logical px (72 input row + reply); the shell clamps it to 72…432. */
	windowBarHeight: (height: number) => invoke<void>("window_bar_height", { height }),
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

export const onHotkeysStatus = (handler: (status: HotkeysStatus) => void) => listen<HotkeysStatus>("hotkeys_status", handler);

let nextId = 0;
/** Unique id for prompts and actions sent from this window. */
export function newId(prefix: string): string {
	nextId += 1;
	return `${prefix}-${Date.now().toString(36)}-${nextId}`;
}
