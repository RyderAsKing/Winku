// Runs the bundled agent-desktop CLI (vercel-labs/agent-desktop, Apache-2.0): one process per
// call, one JSON envelope on stdout. See ARCHITECTURE.md "Computer use" for why it isn't the
// long-lived `agent-desktop mcp` server (that server spawns this same CLI for every tool call).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The envelope every command prints (contract 2.x). */
export interface Envelope {
	version?: string;
	ok: boolean;
	command?: string;
	data?: unknown;
	error?: EnvelopeError;
}

export interface EnvelopeError {
	code: string;
	message: string;
	suggestion?: string;
	details?: Record<string, unknown>;
	disposition?: Disposition;
}

export interface Disposition {
	delivery?: string;
	retry?: string;
}

export interface RunOptions {
	/** Piped to the process (type/set-value --stdin), so typed text never shows in its arguments. */
	stdin?: string;
	signal?: AbortSignal;
	/** Kill the process after this long. */
	timeoutMs?: number;
}

export interface RunResult {
	envelope: Envelope;
	/** Wall time of the call, spawn to exit. */
	ms: number;
}

/** Runs one agent-desktop command. Rejects only when it was aborted (DesktopAborted) or the process couldn't run. */
export type DesktopRunner = (args: string[], options?: RunOptions) => Promise<RunResult>;

export class DesktopAborted extends Error {
	constructor() {
		super("Stopped");
	}
}

export const EXE_NAME = process.platform === "win32" ? "agent-desktop.exe" : "agent-desktop";

/**
 * Where the CLI is: WINKU_AGENT_DESKTOP_BIN, else next to this executable (Tauri puts sidecars
 * beside winku.exe and winku-engine.exe). Under `bun run`, execPath is bun itself, so there is
 * none unless the variable is set.
 */
export function findAgentDesktop(env = process.env, execPath = process.execPath): string | undefined {
	const override = env.WINKU_AGENT_DESKTOP_BIN;
	if (override) return existsSync(override) ? override : undefined;
	const beside = join(dirname(execPath), EXE_NAME);
	return existsSync(beside) ? beside : undefined;
}

const OUTPUT_CAP = 8 * 1024 * 1024;

/**
 * A runner for the binary at `bin`. `prefix` goes before the command's own arguments (tests use
 * it to run a fake CLI script with bun). `stateDir` becomes AGENT_DESKTOP_HOME, so snapshots and
 * their ref maps live in Winku's data folder instead of ~/.agent-desktop.
 */
export function cliRunner(bin: string, stateDir: string | undefined, prefix: string[] = []): DesktopRunner {
	return (args, options = {}) =>
		new Promise((resolve, reject) => {
			const { signal, stdin, timeoutMs } = options;
			if (signal?.aborted) return reject(new DesktopAborted());
			const started = performance.now();
			const env: NodeJS.ProcessEnv = { ...process.env, ...(stateDir ? { AGENT_DESKTOP_HOME: stateDir } : {}) };
			// No AGENT_DESKTOP_SESSION from the user's environment: Winku uses the global namespace in its own state root.
			delete env.AGENT_DESKTOP_SESSION;
			const child = spawn(bin, [...prefix, ...args], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				shell: false,
				env,
			});
			let out = "";
			let err = "";
			let settled = false;
			let timedOut = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				fn();
			};
			const onAbort = () => {
				child.kill();
				finish(() => reject(new DesktopAborted()));
			};
			const timer = timeoutMs
				? setTimeout(() => {
						timedOut = true;
						child.kill();
					}, timeoutMs)
				: undefined;
			signal?.addEventListener("abort", onAbort, { once: true });
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				if (out.length < OUTPUT_CAP) out += chunk;
			});
			child.stderr.on("data", (chunk: string) => {
				if (err.length < 4096) err += chunk;
			});
			child.once("error", (error) => finish(() => reject(new Error(`agent-desktop could not start: ${error.message}`))));
			child.once("close", (code) => {
				const ms = Math.round(performance.now() - started);
				finish(() => {
					if (timedOut) {
						return resolve({ ms, envelope: failure("TIMEOUT", `agent-desktop took longer than ${timeoutMs} ms and was stopped`) });
					}
					resolve({ ms, envelope: parseEnvelope(out, code, err) });
				});
			});
			child.stdin.on("error", () => {});
			child.stdin.end(stdin ?? "");
		});
}

export function failure(code: string, message: string): Envelope {
	return { ok: false, error: { code, message } };
}

/** The last JSON line of stdout (there is exactly one), or an INTERNAL envelope describing what went wrong. */
export function parseEnvelope(stdout: string, exitCode: number | null, stderr = ""): Envelope {
	const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
	if (line) {
		try {
			const value = JSON.parse(line) as Envelope;
			if (value && typeof value === "object" && typeof value.ok === "boolean") return value;
		} catch {}
	}
	const why = stderr.trim().split(/\r?\n/).pop() || `exit code ${exitCode}`;
	return failure("INTERNAL", `agent-desktop gave no result (${why})`);
}
