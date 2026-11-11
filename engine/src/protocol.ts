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
	| { kind: "user"; id: string; text: string; images: number; now?: NowLine; spoken?: boolean; at: number }
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

export interface VoiceProfileInfo {
	/** File stem: voice\<name>.md. */
	name: string;
	/** First non-empty line, without a leading "#", for a short label. */
	summary: string;
}

export interface ToolPermissionRequest {
	/** The reply or agent action this tool call belongs to. */
	replyId?: string;
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
	/** Brave Search API key (Credential Manager, account "search-api-key"). Without it there is no web_search tool, only web_fetch. Held in memory only. */
	searchApiKey?: string;
	/** How the assistant talks to the user (settings: "Its voice"). Free text, may be empty. */
	assistantStyle: string;
	/** settings.voiceProfiles.default: the profile (file stem in voice\) used when no app rule matches. */
	defaultVoiceProfile?: string;
}

/** How much of a spoken reply is said (settings.voice.say, SPEC §11). */
export type SpeechLength = "brief" | "enough" | "full";

export type Command =
	| ConfigureCommand
	| {
			type: "prompt";
			/** Prompt id; echoed on every event of this reply. */
			id: string;
			text: string;
			now?: NowLine;
			images?: ImageAttachment[];
			/** The user spoke this (hold-to-talk). Recorded in the thread; says nothing about TTS. */
			spoken?: boolean;
			/**
			 * The reply will be read aloud (the UI decides, from settings.voice.reply). The model
			 * then starts it with a <say> block, written for listening, of about this length; the
			 * engine sends each block as `say` and keeps it out of text_delta.
			 */
			speak?: SpeechLength;
			/** Voice profile name (file stem in voice\) for the active app, picked by the shell. */
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
	/**
	 * Run an action on a selection (SPEC §6). The shell sends this from an action hotkey, with
	 * an id of its own ("action-…"). Result data: { queued: boolean }, as soon as it starts.
	 *  - replace/show: a one-off call on the Quick model (Main if no Quick). Not added to the
	 *    thread. Streams action_delta, then action_end; a failure sends error (with this id)
	 *    then action_end with aborted: true. Recorded in engine\actions.jsonl for History.
	 *    useThreadContext adds the current thread's messages as context; useVoice adds the
	 *    contents of voice\<voiceProfile>.md (else the configured default profile) to the
	 *    instructions. The mood tag is stripped and ignored.
	 *  - agent: a normal prompt in the current thread with tools ("<prompt>\n\nSelected text: …"),
	 *    with this id: thinking, text_delta, tool_*, reply_end. Queued like prompt if busy.
	 * `abort` stops a running action too.
	 */
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
	/** Undo one memory save: restores the index and topic file as they were before it. Emits memory_undone. */
	| { type: "memory_undo"; id?: string; saveId: string }
	/** Wipe memory\ entirely (Settings > Forget everything, after the UI's confirmation). Result data: { removed: number } (files). */
	| { type: "memory_forget_all"; id?: string }
	/** Accept writes voice\<profile>.md with the proposed content; Dismiss drops it. Result data: { written: boolean }. */
	| { type: "voice_proposal_decision"; id?: string; proposalId: string; accept: boolean }
	/** Result data: VoiceProfileInfo[] for the files in voice\, sorted by name. */
	| { type: "voice_list"; id: string }
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
	/**
	 * A <say> block of a reply to a prompt with `speak`, complete, to read aloud. Sent as soon
	 * as the block closes, usually before the written part; a reply can have several (a short
	 * one before tools, the answer after). Never part of text_delta or reply_end.text, except
	 * that a reply with nothing written ends with its last block as the text.
	 */
	| { type: "say"; id: string; text: string }
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
	/** The model saved a memory (memory_save tool) during reply `id`. */
	| { type: "memory_saved"; id?: string; saveId: string; title: string }
	| { type: "memory_undone"; saveId: string }
	/** The model proposed a change to a voice profile (voice_propose tool). `current` is the file as it is now ("" if new). */
	| { type: "voice_proposal"; id?: string; proposalId: string; profile: string; content: string; current: string; reason: string }
	| { type: "error"; id?: string; errorKind: ErrorKind; message: string };

export type Request =
	/** look_at_screen: the window that was active before the bar (or the foreground window if the
	 *  bar is hidden). Screenshot downscaled to at most 1568 px on the long edge (only when
	 *  includeImage), and up to ~8000 characters of its UI Automation text. Response data: ScreenCapture. */
	| { type: "request"; id: string; method: "screen_capture"; params: { includeImage: boolean } }
	/** Ask before running. Response data: { decision: "allow_once" | "always" | "deny" }.
	 *  On "always" the UI also adds allowKey to settings.alwaysAllow. */
	| { type: "request"; id: string; method: "permission"; params: ToolPermissionRequest };

export interface ScreenCapture {
	app?: string;
	windowTitle?: string;
	text?: string;
	image?: ImageAttachment;
}

export type OutboundMessage = Event | Result | Request;
