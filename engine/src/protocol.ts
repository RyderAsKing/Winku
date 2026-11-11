// JSON-lines protocol between the Tauri shell (stdin) and winku-engine (stdout).

export type InboundMessage =
	| {
			type: "configure";
			/** Root of Winku's data folder, e.g. %APPDATA%\winku. */
			dataDir: string;
			provider: string;
			model: string;
			/** Held in memory only; never written to disk. */
			apiKey?: string;
			thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	  }
	| { type: "prompt"; id: string; text: string }
	| { type: "abort" }
	| { type: "stats" }
	| { type: "shutdown" };

export type OutboundMessage =
	| { type: "hello"; engine: string; pi: string }
	| { type: "ready"; provider: string; model: string; contextWindow: number }
	| { type: "text_delta"; id: string; delta: string }
	| { type: "reply_end"; id: string; text: string; aborted: boolean }
	| { type: "error"; id?: string; message: string }
	| { type: "stats"; rssBytes: number; heapUsedBytes: number; uptimeMs: number };

export function send(message: OutboundMessage): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (line.trim()) yield line;
			newline = buffer.indexOf("\n");
		}
	}
	if (buffer.trim()) yield buffer;
}
