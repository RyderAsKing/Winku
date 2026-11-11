// stdout/stdin plumbing for the JSON-lines protocol. Types live in protocol.ts.
import type { OutboundMessage } from "./protocol.ts";

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
