// Drives the engine over its real stdin/stdout protocol.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FauxOptions } from "../src/faux.ts";
import type { ConfigureCommand, InboundMessage, OutboundMessage, Result } from "../src/protocol.ts";

// Runs src/main.ts by default. Set WINKU_ENGINE_BIN to test a compiled binary instead.
const command = process.env.WINKU_ENGINE_BIN
	? [process.env.WINKU_ENGINE_BIN]
	: [process.execPath, "run", join(import.meta.dir, "../src/main.ts")];

export type Configure = ConfigureCommand & { faux?: FauxOptions };

export function fauxConfig(dataDir: string, extra: Partial<Configure> = {}): Configure {
	return {
		type: "configure",
		dataDir,
		provider: { kind: "catalog", id: "winku-faux" },
		main: { id: "faux-1", thinking: "medium" },
		askBeforeRunning: false,
		alwaysAllow: [],
		assistantStyle: "",
		...extra,
	};
}

export class EngineProcess {
	readonly records: OutboundMessage[] = [];
	private waiters: { pred: (r: OutboundMessage) => boolean; from: number; resolve: (r: OutboundMessage) => void }[] = [];
	private nextId = 0;
	readonly proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
	readonly done: Promise<void>;

	constructor(
		readonly root: string,
		readonly home: string,
		readonly dataDir: string,
	) {
		this.proc = Bun.spawn(command, {
			cwd: root,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, XDG_DATA_HOME: home, XDG_CONFIG_HOME: home },
		});
		this.done = this.read();
	}

	static start(): EngineProcess {
		const root = mkdtempSync(join(tmpdir(), "winku-test-"));
		const home = join(root, "home");
		mkdirSync(home);
		return new EngineProcess(root, home, join(root, "data"));
	}

	/** Start a second engine on the same data folder (restart). */
	restart(): EngineProcess {
		return new EngineProcess(this.root, this.home, this.dataDir);
	}

	private async read(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of this.proc.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				const record = JSON.parse(line) as OutboundMessage;
				this.records.push(record);
				const index = this.records.length - 1;
				this.waiters = this.waiters.filter((w) => {
					if (index >= w.from && w.pred(record)) {
						w.resolve(record);
						return false;
					}
					return true;
				});
			}
		}
	}

	send(message: InboundMessage | Record<string, unknown>): void {
		this.proc.stdin.write(`${JSON.stringify(message)}\n`);
		this.proc.stdin.flush();
	}

	/** Wait for a record matching pred, looking at records from index `from` (default: all). */
	waitFor<T extends OutboundMessage = OutboundMessage>(pred: (r: OutboundMessage) => boolean, from = 0, timeoutMs = 10_000): Promise<T> {
		const existing = this.records.slice(from).find(pred);
		if (existing) return Promise.resolve(existing as T);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out; records: ${JSON.stringify(this.records.slice(-8))}`)), timeoutMs);
			this.waiters.push({
				pred,
				from,
				resolve: (r) => {
					clearTimeout(timer);
					resolve(r as T);
				},
			});
		});
	}

	/** Send a command with a fresh id and wait for its Result. */
	async call(message: Record<string, unknown>): Promise<Result> {
		const id = `c${++this.nextId}`;
		const from = this.records.length;
		this.send({ ...message, id });
		return this.waitFor<Result>((r) => r.type === "result" && r.id === id, from);
	}

	async callOk<T = unknown>(message: Record<string, unknown>): Promise<T> {
		const result = await this.call(message);
		if (!result.ok) throw new Error(`${String(message.type)} failed: ${result.error}`);
		return result.data as T;
	}

	async configure(extra: Partial<Configure> = {}): Promise<void> {
		await this.callOk(fauxConfig(this.dataDir, extra) as unknown as Record<string, unknown>);
	}

	/** Send a prompt and wait for its reply_end. Returns the records of that reply. */
	async prompt(text: string, extra: Record<string, unknown> = {}): Promise<{ end: Extract<OutboundMessage, { type: "reply_end" }>; records: OutboundMessage[] }> {
		const id = `p${++this.nextId}`;
		const from = this.records.length;
		this.send({ type: "prompt", id, text, ...extra });
		const end = await this.waitFor<Extract<OutboundMessage, { type: "reply_end" }>>((r) => r.type === "reply_end" && r.id === id, from);
		return { end, records: this.records.slice(from).filter((r) => "id" in r && r.id === id) };
	}

	async shutdown(): Promise<{ exitCode: number; stderr: string }> {
		this.send({ type: "shutdown" });
		this.proc.stdin.end();
		await this.done;
		const exitCode = await this.proc.exited;
		return { exitCode, stderr: await new Response(this.proc.stderr).text() };
	}
}

export function deltas(records: OutboundMessage[]): string {
	return records.map((r) => (r.type === "text_delta" ? r.delta : "")).join("");
}
