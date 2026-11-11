// Mirror of app/src-tauri/src/settings.rs. Keep the two in sync; docs/ARCHITECTURE.md has the schema.
import type { ActionSpec, ModelChoice, ProviderConfig } from "../../../../engine/src/protocol.ts";

export type ReplyMode = "mirror" | "always_voice" | "always_text";
export type UpdateMode = "auto" | "notify" | "off";

export interface Hotkeys {
	summon: string;
	/** Slots 1–5. */
	actions: string[];
	askSelection: string;
	screenshot: string;
	clear: string;
	cycleThinking: string;
}

export type EyeSize = "small" | "medium" | "large";

export interface Settings {
	version: 1;
	provider: ProviderConfig | null;
	main: ModelChoice | null;
	/** null = follow main with thinking "off". */
	quick: ModelChoice | null;
	compactionReserveTokens: number | null;
	askBeforeRunning: boolean;
	alwaysAllow: string[];
	assistantStyle: string;
	voiceProfiles: { default: string; byApp: Record<string, string> };
	/** Slots 1–5, in order. */
	actions: ActionSpec[];
	hotkeys: Hotkeys;
	leaderKey: string | null;
	eyes: { hidden: boolean; size: EyeSize; positions: Record<string, { x: number; y: number }> };
	voice: {
		stt: "moonshine-base" | "whisper-base-en" | "parakeet";
		tts: "os" | "kokoro";
		osVoice: string | null;
		reply: ReplyMode;
		listeningPaused: boolean;
	};
	updates: UpdateMode;
	launchAtLogin: boolean;
}
