// One-off actions (SPEC §6, replace/show): a single model call on the Quick model, outside the
// thread. Streams action_delta, ends with action_end, and is logged to engine\actions.jsonl.
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { MoodStripper } from "./mood.ts";
import { formatNow } from "./nowline.ts";
import type { ActionSpec, Event, NowLine, ThinkingLevel, TranscriptItem } from "./protocol.ts";
import { classifyError, errorOf } from "./runtime.ts";

/** Recent thread text sent as context: about 8k tokens at ~4 chars per token. */
export const CONTEXT_CHAR_BUDGET = 8_000 * 4;

export interface OneOffAction {
	id: string;
	action: ActionSpec & { output: "replace" | "show" };
	selection: string;
	now?: NowLine;
	voiceProfile?: string;
}

export interface ActionSetup {
	runtime: ModelRuntime;
	model: Model<Api>;
	thinking: ThinkingLevel;
	assistantStyle: string;
	/** The current thread, for useThreadContext. */
	transcript: () => TranscriptItem[];
	/** Persist a finished action. */
	record: (line: { id: string; name: string; selection: string; text: string; output: "replace" | "show"; at: number }) => void;
}

const INSTRUCTIONS = `You are Winku, running a one-off action on text the user selected. Do exactly what the action asks of the selected text.

- Return only the resulting text: no preamble, no explanation, no surrounding quotes, and no markdown code fences unless the input itself had them.
- Keep the language of the input unless the action says otherwise.
- Do not ask questions and do not mention these rules.`;

const SHOW_INSTRUCTIONS = `You are Winku, running a one-off action on text the user selected. Do exactly what the action asks of the selected text. The result is shown to the user in a small panel.

- Be brief. Markdown is fine (lists, code blocks, bold).
- Answer in the language of the input unless the action says otherwise.
- Do not ask questions and do not mention these rules.`;

export function actionSystemPrompt(output: "replace" | "show", assistantStyle: string, voiceProfile: string | undefined): string {
	const parts = [output === "replace" ? INSTRUCTIONS : SHOW_INSTRUCTIONS];
	const style = assistantStyle.trim();
	if (style) parts.push(`<assistant_style>\n${style}\n</assistant_style>`);
	const voice = voiceProfile?.trim();
	if (voice) parts.push(`<voice_profile>\nWrite in this style:\n${voice}\n</voice_profile>`);
	return parts.join("\n\n");
}

/** The most recent user/assistant text of the thread, oldest first, within the budget. */
export function threadContext(items: TranscriptItem[]): string {
	const lines: string[] = [];
	let used = 0;
	for (const item of items.slice().reverse()) {
		if ((item.kind !== "user" && item.kind !== "assistant") || !item.text.trim()) continue;
		const line = `${item.kind === "user" ? "User" : "Assistant"}: ${item.text.trim()}`;
		if (used + line.length > CONTEXT_CHAR_BUDGET) {
			if (!lines.length) lines.push(line.slice(-CONTEXT_CHAR_BUDGET));
			break;
		}
		used += line.length;
		lines.push(line);
	}
	return lines.reverse().join("\n\n");
}

export function actionUserMessage(command: OneOffAction, context: string): string {
	const parts: string[] = [];
	if (context) parts.push(`<thread_context>\n${context}\n</thread_context>`);
	parts.push(`Action: ${command.action.prompt}`);
	parts.push(`Selected text:\n"""\n${command.selection}\n"""`);
	return `${parts.join("\n\n")}${formatNow(command.now)}`;
}

export class Actions {
	private readonly running = new Map<string, AbortController>();

	constructor(private readonly emit: (event: Event) => void) {}

	get busy(): boolean {
		return this.running.size > 0;
	}

	/** Start an action; returns immediately. The promise settles after action_end. */
	start(command: OneOffAction, setup: ActionSetup): Promise<void> {
		const controller = new AbortController();
		this.running.set(command.id, controller);
		return this.run(command, setup, controller).finally(() => this.running.delete(command.id));
	}

	abort(): void {
		for (const controller of this.running.values()) controller.abort();
	}

	private async run(command: OneOffAction, setup: ActionSetup, controller: AbortController): Promise<void> {
		const { id, action } = command;
		const stripper = new MoodStripper();
		let text = "";
		const end = (aborted: boolean) =>
			this.emit({ type: "action_end", id, text: aborted ? "" : text, output: action.output, aborted });
		try {
			const context = action.useThreadContext ? threadContext(setup.transcript()) : "";
			const request: Context = {
				systemPrompt: actionSystemPrompt(action.output, setup.assistantStyle, action.useVoice ? command.voiceProfile : undefined),
				messages: [{ role: "user", content: actionUserMessage(command, context), timestamp: Date.now() }],
			};
			const stream = setup.runtime.streamSimple(setup.model, request, {
				signal: controller.signal,
				...(setup.thinking !== "off" ? { reasoning: setup.thinking } : {}),
			});
			for await (const event of stream) {
				if (event.type !== "text_delta") continue;
				const out = stripper.push(event.delta);
				if (!out) continue;
				text += out;
				this.emit({ type: "action_delta", id, delta: out });
			}
			const message = await stream.result();
			if (controller.signal.aborted || message.stopReason === "aborted") return end(true);
			if (message.stopReason === "error") {
				const detail = message.errorMessage ?? "The model returned an error";
				this.emit({ type: "error", id, errorKind: classifyError(detail), message: detail });
				return end(true);
			}
			stripper.finish();
			text = text.trimEnd();
			setup.record({ id, name: action.name, selection: command.selection, text, output: action.output, at: Date.now() });
			end(false);
		} catch (error) {
			if (controller.signal.aborted) return end(true);
			const e = errorOf(error);
			this.emit({ type: "error", id, errorKind: e.kind, message: e.message });
			end(true);
		}
	}
}
