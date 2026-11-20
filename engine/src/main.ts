import "./isolate.ts";
import enginePackage from "../package.json" with { type: "json" };
import { Engine, type EngineConfig } from "./engine.ts";
import { readLines, send } from "./io.ts";
import { ShellRequests } from "./requests.ts";
import type { Command, InboundMessage } from "./protocol.ts";
import { extensionOf, installExtension, listExtensions, removeExtension } from "./extensions.ts";
import { builtInProviderIds, errorOf, listModels, listProviders, testConnection } from "./runtime.ts";

const startedAt = performance.now();
const requests = new ShellRequests(send);
const engine = new Engine(send, requests);

function reply(id: string | undefined, data?: unknown): void {
	if (id !== undefined) send({ type: "result", id, ok: true, ...(data !== undefined ? { data } : {}) });
}

function replyError(id: string | undefined, error: unknown): void {
	const e = errorOf(error);
	const kind = e.message === "Engine is not configured" ? "config" : e.kind;
	if (id !== undefined) send({ type: "result", id, ok: false, error: e.message, errorKind: kind });
	else send({ type: "error", errorKind: kind, message: e.message });
}

const LATER: Partial<Record<Command["type"], number>> = {};

/** Commands that change engine state run one at a time, in order. Reads and abort don't wait. */
const SERIAL = new Set<Command["type"]>(["configure", "prompt", "set_thinking", "notice", "clear", "undo_clear", "history_restore"]);

async function handle(message: Command): Promise<unknown> {
	switch (message.type) {
		case "configure":
			await engine.configure(message as EngineConfig);
			return undefined;
		case "prompt": {
			if (!engine.configured) throw new Error("Engine is not configured");
			return { steered: await engine.prompt(message) };
		}
		case "notice":
			await engine.notice(message.text);
			return undefined;
		case "run_action": {
			if (!engine.configured) throw new Error("Engine is not configured");
			const { action } = message;
			if (action.output === "agent") {
				const text = `${action.prompt}\n\nSelected text:\n"""\n${message.selection}\n"""`;
				return { steered: await engine.prompt({ type: "prompt", id: message.id, text, now: message.now }) };
			}
			engine.runOneOff({ ...message, action: { ...action, output: action.output } });
			return { steered: false };
		}
		case "abort":
			await engine.abort();
			return undefined;
		case "set_thinking":
			return { level: engine.setThinking(message.role, message.level) };
		case "clear":
			return engine.clear();
		case "undo_clear":
			await engine.undoClear(message.undoToken);
			return undefined;
		case "transcript":
			return engine.threadState.transcript();
		case "history_list":
			return engine.threadState.list(message.query);
		case "history_read":
			return engine.threadState.read(message.entryId);
		case "history_delete":
			await engine.threadState.delete(message.entryId);
			return undefined;
		case "history_restore":
			await engine.restore(message.entryId);
			return undefined;
		case "memory_undo":
			engine.undoMemory(message.saveId);
			return undefined;
		case "memory_forget_all":
			return { removed: engine.forgetMemory() };
		case "memory_overview":
			return engine.memoryOverview();
		case "memory_preview":
			return engine.memoryPreview(message.text);
		case "memory_map":
			return engine.memoryMap();
		case "memory_core_set":
			engine.setMemoryCore(message.which, message.text);
			return undefined;
		case "memory_note_delete":
			engine.deleteMemoryNote(message.topic, message.noteId);
			return undefined;
		case "memory_tidy":
			return engine.tidyNow();
		case "voice_proposal_decision":
			return engine.voiceDecision(message.proposalId, message.accept);
		case "voice_list":
			return engine.voiceList();
		case "list_providers":
			return listProviders();
		case "extensions_list":
			return listExtensions();
		case "extension_install": {
			const builtIn = await builtInProviderIds();
			return installExtension(message.source, (id) => builtIn.has(id));
		}
		case "extension_remove": {
			const inUse = engine.providerId;
			if (inUse && (await extensionOf(inUse)) === message.name)
				throw new Error("Your model comes from this extension. Pick another provider and save first.");
			await removeExtension(message.name);
			return undefined;
		}
		case "list_models":
			return listModels(message.provider, message.apiKey);
		case "test_connection":
			return testConnection(
				message.provider,
				message.apiKey,
				message.model,
				(message as { faux?: EngineConfig["faux"] }).faux,
			);
		case "stats": {
			const memory = process.memoryUsage();
			return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, uptimeMs: Math.round(performance.now() - startedAt) };
		}
		default: {
			const step = LATER[message.type];
			throw new Error(step ? `Not available until step ${step}` : `Unknown command "${message.type}"`);
		}
	}
}

async function main(): Promise<void> {
	send({ type: "hello", engine: enginePackage.version, pi: enginePackage.dependencies["@earendil-works/pi-coding-agent"] });
	let serial: Promise<void> = Promise.resolve();
	const inFlight = new Set<Promise<void>>();

	for await (const line of readLines(Bun.stdin.stream())) {
		let message: InboundMessage;
		try {
			message = JSON.parse(line);
		} catch {
			send({ type: "error", errorKind: "engine", message: `Invalid JSON: ${line.slice(0, 200)}` });
			continue;
		}
		if (message.type === "response") {
			requests.handle(message);
			continue;
		}
		if (message.type === "shutdown") break;

		const command = message;
		const run = async () => {
			try {
				reply(command.id, await handle(command));
			} catch (error) {
				if (command.type === "prompt" || command.type === "run_action") {
					const e = errorOf(error);
					send({ type: "error", id: command.id, errorKind: e.message === "Engine is not configured" ? "config" : e.kind, message: e.message });
					if (command.type === "run_action" && command.action.output !== "agent")
						send({ type: "action_end", id: command.id, text: "", output: command.action.output, aborted: true });
				}
				replyError(command.id, error);
			}
		};
		const task = SERIAL.has(command.type) ? (serial = serial.then(run)) : run();
		inFlight.add(task);
		void task.finally(() => inFlight.delete(task));
	}

	await Promise.allSettled([...inFlight]);
	await engine.dispose().catch(() => {});
	process.exit(0);
}

void main();
