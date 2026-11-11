// Scripted test provider (`winku-faux`). Lets `bun test` drive the engine offline.
// Only honoured when the provider is { kind: "catalog", id: "winku-faux" }.
import {
	type AssistantMessage,
	fauxAssistantMessage,
	type FauxContentBlock,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	getCurrentSystemPrompt,
	type Message,
	type Provider,
} from "@earendil-works/pi-ai";

export const FAUX_PROVIDER = "winku-faux";

/** One scripted assistant response. Consumed in order; the default echoes the last user message. */
export interface FauxStep {
	text?: string;
	thinking?: string;
	toolCalls?: { name: string; arguments?: Record<string, unknown> }[];
	/** Respond with stopReason "error" and this message. */
	error?: string;
	/** Reply with the current system prompt (for prompt-stability tests). */
	echoSystemPrompt?: boolean;
	/** Reply with the full text of the last user message, including the <now> tag and image count. */
	echoUser?: boolean;
	/** Reply with "<model id> reasoning=<level>" of the request (which model and thinking level was used). */
	echoModel?: boolean;
}

/** Test-only extension of the configure command. Not part of protocol.ts. */
export interface FauxOptions {
	replies?: FauxStep[];
	contextWindow?: number;
	tokensPerSecond?: number;
	reasoning?: boolean;
	supportsImages?: boolean;
	/** pi's compaction keepRecentTokens (default 20000), so tests can compact a tiny context. */
	keepRecentTokens?: number;
}

function userText(message: Message | undefined): { text: string; images: number } {
	if (!message || message.role !== "user") return { text: "", images: 0 };
	if (typeof message.content === "string") return { text: message.content, images: 0 };
	return {
		text: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
		images: message.content.filter((block) => block.type === "image").length,
	};
}

export function createFauxProvider(modelIds: string[], options: FauxOptions = {}): Provider {
	const faux = fauxProvider({
		provider: FAUX_PROVIDER,
		models: modelIds.map((id) => ({
			id,
			contextWindow: options.contextWindow ?? 200_000,
			reasoning: options.reasoning ?? true,
			input: options.supportsImages === false ? ["text"] : ["text", "image"],
		})),
		tokensPerSecond: options.tokensPerSecond ?? 2000,
	});
	const script = [...(options.replies ?? [])];
	faux.setResponses(
		Array.from({ length: 1000 }, () => (context, options, _state, model): AssistantMessage => {
			const step = script.shift();
			const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
			if (!step) return fauxAssistantMessage(`Hello from winku-engine. You said: ${userText(lastUser).text}`);
			if (step.error) return fauxAssistantMessage("", { stopReason: "error", errorMessage: step.error });
			if (step.echoSystemPrompt) return fauxAssistantMessage(getCurrentSystemPrompt(context.messages));
			if (step.echoModel) return fauxAssistantMessage(`${model.id} reasoning=${options?.reasoning ?? "off"}`);
			if (step.echoUser) {
				const { text, images } = userText(lastUser);
				return fauxAssistantMessage(`${text}\n[images:${images}]`);
			}
			const blocks: FauxContentBlock[] = [];
			if (step.thinking) blocks.push(fauxThinking(step.thinking));
			if (step.text) blocks.push(fauxText(step.text));
			for (const call of step.toolCalls ?? []) blocks.push(fauxToolCall(call.name, (call.arguments ?? {}) as never));
			return fauxAssistantMessage(blocks, { stopReason: step.toolCalls?.length ? "toolUse" : "stop" });
		}),
	);
	return faux.provider;
}
