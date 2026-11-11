// JSON-lines protocol between the Tauri shell and winku-engine.
//
// One JSON object per line. The shell writes Commands and Responses to the engine's stdin.
// The engine writes Events, Results and Requests to stdout. Nothing else may go to stdout.
//
//   shell → engine   Command   { type, id?, ... }      id present = shell wants a Result
//   engine → shell   Result    { type: "result", id, ok, data | error }
//   engine → shell   Event     { type, ... }           fire-and-forget
//   engine → shell   Request   { type: "request", id, method, params }
//   shell → engine   Response  { type: "response", id, ok, data | error }
//
// This file is the source of truth and holds types only (the UI type-checks against it).
// docs/ARCHITECTURE.md describes the flows; io.ts has the stdout/stdin helpers.

// ───────────────────────────── shared shapes ─────────────────────────────

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Which model a call uses. "quick" is the Quick actions model, which follows "main" until changed. */
export type ModelRole = "main" | "quick";

export type ProviderConfig =
	/** A provider from pi's bundled catalog, e.g. "anthropic", "openai", "openrouter". */
	| { kind: "catalog"; id: string }
	/** Any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, …). */
	| {
			kind: "custom";
			/** e.g. "http://localhost:11434/v1" */
			baseUrl: string;
			/** Models the user picked or typed. Capabilities come from Test connection or user edits. */
			models: CustomModel[];
	  };

export interface CustomModel {
	id: string;
	supportsImages: boolean;
	contextWindow: number;
}

export interface ModelChoice {
	id: string;
	thinking: ThinkingLevel;
}

export interface ModelInfo {
	id: string;
	name: string;
	supportsImages: boolean;
	contextWindow: number;
	/** Thinking levels this model accepts, ["off"] when it has no reasoning. */
	thinkingLevels: ThinkingLevel[];
}

export interface ProviderInfo {
	id: string;
	name: string;
	/** Where the user gets a key, when known. */
	keyUrl?: string;
}

/** What the user was looking at when they sent the message. Appended to the end of the user message. */
export interface NowLine {
	app?: string;
	windowTitle?: string;
	selection?: string;
}

export interface ImageAttachment {
	/** base64, no data: prefix */
	data: string;
	mimeType: "image/png" | "image/jpeg" | "image/webp";
}

export type Mood = "happy" | "hearts" | "neutral" | "sad" | "surprised" | "thinking";

export type ErrorKind = "auth" | "network" | "model" | "config" | "engine";

/** One row in the transcript. The UI renders these; the engine builds them from the session. */
export type TranscriptItem =
	| { kind: "user"; id: string; text: string; images: number; now?: NowLine; at: number }
	| { kind: "assistant"; id: string; text: string; mood?: Mood; aborted?: boolean; at: number }
	| { kind: "tool"; id: string; name: string; summary: string; ok: boolean | null; detail?: string; at: number }
	| { kind: "compaction"; id: string; summary: string; at: number }
	| { kind: "memory_saved"; id: string; saveId: string; title: string; undone: boolean; at: number }
	| { kind: "error"; id: string; errorKind: ErrorKind; message: string; at: number };

export interface HistoryEntry {
	/** Session id, or action-log id for one-off actions. */
	id: string;
	kind: "thread" | "action";
	/** First user message, or the action name and the start of the selection. */
	title: string;
	startedAt: number;
	updatedAt: number;
	messageCount: number;
	current: boolean;
}

export interface ActionSpec {
	name: string;
	prompt: string;
	output: "replace" | "show" | "agent";
	/** Include the current thread as context for replace/show actions. */
	useThreadContext: boolean;
	/** Apply the active voice profile (rewriting actions). */
	useVoice: boolean;
}

export interface ToolPermissionRequest {
	tool: string;
	/** One-line, human-readable: "Run: Remove-Item C:\\tmp\\x -Recurse" */
	summary: string;
	/** Stable key for "Always allow this command", e.g. "powershell:Remove-Item". */
	allowKey: string;
}

// ───────────────────────────── shell → engine ─────────────────────────────

export interface ConfigureCommand {
	type: "configure";
	id?: string;
	/** Root of Winku's data folder: %APPDATA%\winku on Windows. */
	dataDir: string;
	provider: ProviderConfig;
	/** Held in memory only. Never written to disk by the engine. */
	apiKey?: string;
	main: ModelChoice;
	/** Absent = follow main, with thinking "off". */
	quick?: ModelChoice;
	/** Compaction starts when context exceeds window - reserveTokens. */
	compactionReserveTokens?: number;
	askBeforeRunning: boolean;
	/** allowKey values the user chose "Always allow" for. */
	alwaysAllow: string[];
	/** How the assistant talks to the user (settings: "Its voice"). Free text, may be empty. */
	assistantStyle: string;
	/** Voice profile chosen for the active app, by file stem (e.g. "casual"). */
	defaultVoiceProfile?: string;
}

export type Command =
	| ConfigureCommand
	| {
			type: "prompt";
			/** Prompt id; echoed on every event of this reply. */
			id: string;
			text: string;
			now?: NowLine;
			images?: ImageAttachment[];
			/** The user spoke this (hold-to-talk). The shell decides about TTS; the engine only records it. */
			spoken?: boolean;
			/** Voice profile for this message, picked by the shell from the active app. */
			voiceProfile?: string;
	  }
	| { type: "abort"; id?: string }
	| { type: "set_thinking"; id?: string; role: ModelRole; level: ThinkingLevel }
	/** Archive the current thread and start a new one. Result data: { undoToken: string }. */
	| { type: "clear"; id?: string }
	/** Within the Undo window: drop the new empty thread and switch back. */
	| { type: "undo_clear"; id?: string; undoToken: string }
	/** Result data: TranscriptItem[] for the current thread. */
	| { type: "transcript"; id: string }
	/** Result data: HistoryEntry[], newest first. query searches message text. */
	| { type: "history_list"; id: string; query?: string }
	/** Result data: TranscriptItem[]. */
	| { type: "history_read"; id: string; entryId: string }
	/** Archive the current thread, make entryId current. Emits thread_changed. */
	| { type: "history_restore"; id?: string; entryId: string }
	/** One-off (replace/show) or agent action. Emits action_* events for replace/show. */
	| {
			type: "run_action";
			id: string;
			action: ActionSpec;
			selection: string;
			now?: NowLine;
			voiceProfile?: string;
	  }
	/** Result data: ProviderInfo[] from pi's bundled catalog. */
	| { type: "list_providers"; id: string }
	/** Result data: ModelInfo[]. For custom providers the engine calls GET {baseUrl}/models. */
	| { type: "list_models"; id: string; provider: ProviderConfig; apiKey?: string }
	/** Sends a tiny request (and a tiny image, to detect image support).
	 *  Result data: { ok: boolean; supportsImages: boolean; error?: string; errorKind?: ErrorKind }. */
	| { type: "test_connection"; id: string; provider: ProviderConfig; apiKey?: string; model: string }
	| { type: "memory_undo"; id?: string; saveId: string }
	/** Wipe memory\ entirely (Settings > Forget everything, after the shell's confirmation). */
	| { type: "memory_forget_all"; id?: string }
	| { type: "voice_proposal_decision"; id?: string; proposalId: string; accept: boolean }
	/** Result data: { rssBytes, heapUsedBytes, uptimeMs }. */
	| { type: "stats"; id: string }
	| { type: "shutdown" };

export interface Response {
	type: "response";
	id: string;
	ok: boolean;
	data?: unknown;
	error?: string;
}

export type InboundMessage = Command | Response;

// ───────────────────────────── engine → shell ─────────────────────────────

export interface Result {
	type: "result";
	id: string;
	ok: boolean;
	data?: unknown;
	error?: string;
	errorKind?: ErrorKind;
}

export type Event =
	| { type: "hello"; engine: string; pi: string }
	| {
			type: "ready";
			provider: string;
			model: string;
			contextWindow: number;
			supportsImages: boolean;
			thinking: ThinkingLevel;
			thinkingLevels: ThinkingLevel[];
	  }
	/** Waiting on the model (eyes: thinking). Also sent between tool calls. */
	| { type: "thinking"; id: string }
	| { type: "text_delta"; id: string; delta: string }
	| { type: "tool_start"; id: string; toolCallId: string; name: string; summary: string }
	| { type: "tool_end"; id: string; toolCallId: string; ok: boolean; summary: string }
	/** Final text has the mood tag stripped. Sent when the engine is idle again (agent_settled). */
	| { type: "reply_end"; id: string; text: string; aborted: boolean; mood?: Mood }
	| { type: "context"; tokens: number | null; contextWindow: number; percent: number | null }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "compaction_end"; ok: boolean; summary?: string }
	/** Current thread was replaced (clear, undo_clear, restore). The UI reloads the transcript. */
	| { type: "thread_changed"; reason: "clear" | "undo_clear" | "restore"; sessionId: string }
	| { type: "thinking_changed"; role: ModelRole; level: ThinkingLevel }
	| { type: "action_delta"; id: string; delta: string }
	| { type: "action_end"; id: string; text: string; output: "replace" | "show"; aborted: boolean }
	| { type: "memory_saved"; saveId: string; title: string }
	| { type: "memory_undone"; saveId: string }
	| { type: "voice_proposal"; proposalId: string; profile: string; content: string; reason: string }
	| { type: "error"; id?: string; errorKind: ErrorKind; message: string };

export type Request =
	/** Screenshot (downscaled) and UI Automation text of the active window. Response data: ScreenCapture. */
	| { type: "request"; id: string; method: "screen_capture"; params: { includeImage: boolean } }
	/** Ask before running. Response data: { decision: "allow_once" | "always" | "deny" }. */
	| { type: "request"; id: string; method: "permission"; params: ToolPermissionRequest };

export interface ScreenCapture {
	app?: string;
	windowTitle?: string;
	text?: string;
	image?: ImageAttachment;
}

export type OutboundMessage = Event | Result | Request;
