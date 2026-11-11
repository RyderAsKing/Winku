import "./isolate.ts";
import enginePackage from "../package.json" with { type: "json" };
import { type Engine, startEngine } from "./engine.ts";
import { type InboundMessage, readLines, send } from "./protocol.ts";

const startedAt = performance.now();
let engine: Engine | undefined;
let unsubscribe: (() => void) | undefined;
let currentPromptId: string | undefined;

send({ type: "hello", engine: enginePackage.version, pi: enginePackage.dependencies["@earendil-works/pi-coding-agent"] });

async function handle(message: InboundMessage): Promise<boolean> {
	switch (message.type) {
		case "configure": {
			unsubscribe?.();
			engine?.dispose();
			engine = await startEngine(message);
			unsubscribe = engine.session.subscribe((event) => {
				if (
					currentPromptId &&
					event.type === "message_update" &&
					event.assistantMessageEvent.type === "text_delta"
				) {
					send({ type: "text_delta", id: currentPromptId, delta: event.assistantMessageEvent.delta });
				}
			});
			send({
				type: "ready",
				provider: engine.model.provider,
				model: engine.model.id,
				contextWindow: engine.model.contextWindow,
			});
			return true;
		}
		case "prompt": {
			if (!engine) {
				send({ type: "error", id: message.id, message: "Engine is not configured" });
				return true;
			}
			const session = engine.session;
			// Run without awaiting so abort and stats stay responsive while a reply streams.
			void (async () => {
				currentPromptId = message.id;
				try {
					await session.prompt(message.text);
					const last = session.messages.at(-1);
					const text =
						last?.role === "assistant"
							? last.content.map((block) => (block.type === "text" ? block.text : "")).join("")
							: "";
					const aborted = last?.role === "assistant" && last.stopReason === "aborted";
					if (last?.role === "assistant" && last.stopReason === "error") {
						send({ type: "error", id: message.id, message: last.errorMessage ?? "Model error" });
					}
					send({ type: "reply_end", id: message.id, text, aborted });
				} catch (error) {
					send({ type: "error", id: message.id, message: String(error) });
				} finally {
					if (currentPromptId === message.id) currentPromptId = undefined;
				}
			})();
			return true;
		}
		case "abort":
			await engine?.session.abort();
			return true;
		case "stats": {
			const memory = process.memoryUsage();
			send({
				type: "stats",
				rssBytes: memory.rss,
				heapUsedBytes: memory.heapUsed,
				uptimeMs: Math.round(performance.now() - startedAt),
			});
			return true;
		}
		case "shutdown":
			return false;
	}
}

async function main(): Promise<void> {
	for await (const line of readLines(Bun.stdin.stream())) {
		let message: InboundMessage;
		try {
			message = JSON.parse(line);
		} catch {
			send({ type: "error", message: `Invalid JSON: ${line.slice(0, 200)}` });
			continue;
		}
		try {
			if (!(await handle(message))) break;
		} catch (error) {
			send({ type: "error", message: error instanceof Error ? error.message : String(error) });
		}
	}

	unsubscribe?.();
	engine?.dispose();
	process.exit(0);
}

void main();
