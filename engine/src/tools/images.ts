// Screenshots don't survive compaction: images in the messages a compaction kept are replaced
// by a short note in what is sent to the model. The session file keeps them (the transcript
// still counts them), and messages after the compaction keep their images.
import type { AgentSession } from "@earendil-works/pi-coding-agent";

type AgentMessage = Parameters<NonNullable<AgentSession["agent"]["transformContext"]>>[0][number];

export const SCREENSHOT_REMOVED = "[screenshot removed]";

type Block = { type: string; [key: string]: unknown };

function withoutImages(message: AgentMessage): AgentMessage {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content) || !content.some((b: Block) => b?.type === "image")) return message;
	return {
		...message,
		content: (content as Block[]).map((b) => (b.type === "image" ? { type: "text", text: SCREENSHOT_REMOVED } : b)),
	} as unknown as AgentMessage;
}

export function dropCompactedImages(messages: AgentMessage[]): AgentMessage[] {
	let summaryIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if ((messages[i] as { role?: string }).role === "compactionSummary") {
			summaryIndex = i;
			break;
		}
	}
	if (summaryIndex === -1) return messages;
	const compactedAt = (messages[summaryIndex] as { timestamp?: number }).timestamp ?? 0;
	return messages.map((message, i) => {
		if (i <= summaryIndex) return message;
		const at = (message as { timestamp?: number }).timestamp ?? 0;
		return at < compactedAt ? withoutImages(message) : message;
	});
}

/** Apply dropCompactedImages to every request the session sends, after pi's own transforms. */
export function installImageDrop(session: AgentSession): void {
	const agent = session.agent;
	const previous = agent.transformContext;
	agent.transformContext = async (messages, signal) =>
		dropCompactedImages(previous ? await previous(messages, signal) : messages);
}
