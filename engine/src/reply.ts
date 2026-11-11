// One prompt → thinking / text_delta / tool_* / reply_end events. Follows the session's events,
// so the session can be swapped underneath (call attach again).
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { MoodStripper } from "./mood.ts";
import { formatNow } from "./nowline.ts";
import type { Command, ErrorKind, Event, Mood } from "./protocol.ts";
import { classifyError, errorOf } from "./runtime.ts";
import { toolSummary } from "./thread.ts";

type PromptCommand = Extract<Command, { type: "prompt" }>;

interface ActiveReply {
	id: string;
	text: string;
	mood: Mood | undefined;
	stripper: MoodStripper | undefined;
	/** The current assistant message has shown text. */
	shown: boolean;
	/** Last model error; cleared when a later attempt succeeds (retries). */
	error: { message: string; kind: ErrorKind } | undefined;
	tools: Map<string, string>;
}

export function userMessageText(command: Pick<PromptCommand, "text" | "now">): string {
	return `${command.text}${formatNow(command.now)}`;
}

export class Replies {
	private session: AgentSession | undefined;
	/** Prompt ids sent to pi whose user message hasn't started yet, in order. */
	private queue: string[] = [];
	private active: ActiveReply | undefined;
	private readonly ended = new Set<string>();

	constructor(
		private readonly emit: (event: Event) => void,
		private readonly onContextChanged: () => void,
		private readonly onCompacted: (ok: boolean) => void,
	) {}

	get busy(): boolean {
		return !!this.active || this.queue.length > 0 || !!this.session?.isStreaming;
	}

	attach(session: AgentSession): () => void {
		this.session = session;
		return session.subscribe((event) => this.handle(event));
	}

	/** Start a reply, or queue it as a follow-up if one is streaming. Returns whether it was queued. */
	prompt(command: PromptCommand): boolean {
		const session = this.session;
		if (!session) throw new Error("Engine is not configured");
		const images: ImageContent[] = (command.images ?? []).map((image) => ({
			type: "image",
			data: image.data,
			mimeType: image.mimeType,
		}));
		const queued = this.busy;
		this.queue.push(command.id);
		if (!queued) this.emit({ type: "thinking", id: command.id });
		session
			.prompt(userMessageText(command), {
				images,
				expandPromptTemplates: false,
				...(queued ? { streamingBehavior: "followUp" as const } : {}),
			})
			.catch((error) => this.fail(command.id, error));
		return queued;
	}

	/** Stop the run and drop queued follow-ups. Every pending reply gets reply_end aborted:true. */
	async abort(): Promise<void> {
		const session = this.session;
		if (!session) return;
		session.clearQueue();
		await session.abort();
		// If pi had nothing running (e.g. the prompt was still being set up), close what's left.
		if (!session.isStreaming) this.settle(true);
	}

	private fail(id: string, error: unknown): void {
		if (this.ended.has(id)) return;
		const e = errorOf(error);
		this.queue = this.queue.filter((q) => q !== id);
		this.emit({ type: "error", id, errorKind: e.kind, message: e.message });
		if (this.active?.id === id) {
			const active = this.active;
			this.active = undefined;
			this.end(active, false);
		} else {
			this.ended.add(id);
			this.emit({ type: "reply_end", id, text: "", aborted: false });
		}
	}

	private end(reply: ActiveReply, aborted: boolean): void {
		if (this.ended.has(reply.id)) return;
		this.ended.add(reply.id);
		if (reply.error) this.emit({ type: "error", id: reply.id, errorKind: reply.error.kind, message: reply.error.message });
		this.emit({
			type: "reply_end",
			id: reply.id,
			text: reply.text.trimEnd(),
			aborted,
			...(reply.mood ? { mood: reply.mood } : {}),
		});
	}

	private settle(aborted: boolean): void {
		if (this.active) this.end(this.active, aborted);
		this.active = undefined;
		for (const id of this.queue) {
			if (this.ended.has(id)) continue;
			this.ended.add(id);
			this.emit({ type: "reply_end", id, text: "", aborted: true });
		}
		this.queue = [];
	}

	private handle(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_start": {
				if (event.message.role === "user") {
					const id = this.queue.shift();
					if (this.active && this.active.id !== id) this.end(this.active, false);
					this.active = id
						? { id, text: "", mood: undefined, stripper: undefined, shown: false, error: undefined, tools: new Map() }
						: undefined;
				} else if (event.message.role === "assistant" && this.active) {
					this.active.stripper = new MoodStripper();
					this.active.shown = false;
				}
				return;
			}
			case "turn_start":
				if (this.active) this.emit({ type: "thinking", id: this.active.id });
				return;
			case "message_update": {
				const active = this.active;
				const delta = event.assistantMessageEvent;
				if (!active?.stripper || delta.type !== "text_delta") return;
				let out = active.stripper.push(delta.delta);
				if (!out) return;
				// Separate the text of consecutive assistant messages (around tool calls).
				if (active.text && !active.shown) out = `\n\n${out}`;
				active.shown = true;
				active.text += out;
				this.emit({ type: "text_delta", id: active.id, delta: out });
				return;
			}
			case "message_end": {
				const active = this.active;
				const message = event.message;
				if (!active || message.role !== "assistant") return;
				const mood = active.stripper?.finish().mood;
				if (mood) active.mood = mood;
				active.stripper = undefined;
				if (message.stopReason === "error") {
					const text = message.errorMessage ?? "The model returned an error";
					active.error = { message: text, kind: classifyError(text) };
				} else if (message.stopReason !== "aborted") {
					active.error = undefined;
				}
				return;
			}
			case "tool_execution_start": {
				const active = this.active;
				if (!active) return;
				const summary = toolSummary(event.toolName, event.args);
				active.tools.set(event.toolCallId, summary);
				this.emit({ type: "tool_start", id: active.id, toolCallId: event.toolCallId, name: event.toolName, summary });
				return;
			}
			case "tool_execution_end": {
				const active = this.active;
				if (!active) return;
				this.emit({
					type: "tool_end",
					id: active.id,
					toolCallId: event.toolCallId,
					ok: !event.isError,
					summary: active.tools.get(event.toolCallId) ?? event.toolName,
				});
				return;
			}
			case "agent_settled":
				this.settle(event.aborted);
				this.onContextChanged();
				return;
			case "compaction_start":
				this.emit({ type: "compaction_start", reason: event.reason });
				return;
			case "compaction_end": {
				const ok = !!event.result && !event.aborted;
				this.emit({ type: "compaction_end", ok, ...(event.result?.summary ? { summary: event.result.summary } : {}) });
				this.onCompacted(ok);
				this.onContextChanged();
				return;
			}
		}
	}
}
