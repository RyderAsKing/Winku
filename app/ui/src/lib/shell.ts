// Typed wrappers for the shell's commands and events. See docs/ARCHITECTURE.md, "Shell ↔ UI contract".
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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

export type UiEvent =
	| { kind: "summon" }
	| { kind: "hide" }
	| { kind: "toggle_transcript" }
	| { kind: "ask_selection"; text: string }
	| { kind: "attach_screenshot"; image: ImageAttachment }
	| { kind: "clear" }
	| { kind: "cycle_thinking" }
	| { kind: "action_started"; slot: number; name: string; output: "replace" | "show" | "agent" }
	| { kind: "talk_start" }
	| { kind: "talk_level"; level: number }
	| { kind: "talk_end"; text: string }
	| { kind: "menu"; item: "settings" | "history" | "ask_before_running" | "hide_eyes" | "pause_listening" | "quit" }
	| { kind: "update_ready" };

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

/** Commands with a Result. The shell assigns the id. */
type CallCommand = Extract<Command, { id: string }> | Extract<Command, { id?: string }>;

export const shell = {
	send: (message: Command) => invoke<void>("engine_send", { message }),
	call: <T>(message: Omit<CallCommand, "id">) => invoke<T>("engine_call", { message }),
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
	nowLine: () => invoke<NowLine>("now_line"),
	screenshot: () => invoke<ImageAttachment>("screenshot"),
	speak: (text: string) => invoke<void>("speak", { text }),
	stopSpeaking: () => invoke<void>("stop_speaking"),
};

export const onEngine = (handler: (event: EngineEvent | EngineRequest) => void): Promise<UnlistenFn> =>
	listen<EngineEvent | EngineRequest>("engine", ({ payload }) => handler(payload));

export const onUi = (handler: (event: UiEvent) => void): Promise<UnlistenFn> =>
	listen<UiEvent>("ui", ({ payload }) => handler(payload));

export const onSettingsChanged = (handler: (settings: Settings) => void): Promise<UnlistenFn> =>
	listen<Settings>("settings_changed", ({ payload }) => handler(payload));

export const onHotkeysStatus = (handler: (status: HotkeysStatus) => void): Promise<UnlistenFn> =>
	listen<HotkeysStatus>("hotkeys_status", ({ payload }) => handler(payload));
