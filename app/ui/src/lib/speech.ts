// What gets read aloud: a reply's markdown turned into plain sentences. Code and tables stay in
// the bar; the voice says they are there instead of reading them out.
import type { ReplyMode } from "./settings.ts";

/** Whether a finished reply is spoken (SPEC §11). Actions are never spoken. */
export function shouldSpeak(mode: ReplyMode, spoken: boolean): boolean {
	return mode === "always_voice" || (mode === "mirror" && spoken);
}

export function speakable(markdown: string): string {
	const lines: string[] = [];
	let inCode = false;
	let codeNoted = false;
	let tableNoted = false;
	for (const raw of markdown.split("\n")) {
		const line = raw.trim();
		if (/^(```|~~~)/.test(line)) {
			inCode = !inCode;
			if (inCode && !codeNoted) {
				lines.push("The code is in the bar.");
				codeNoted = true;
			}
			continue;
		}
		if (inCode) continue;
		if (/^\|.*\|$/.test(line)) {
			if (!tableNoted) {
				lines.push("The table is in the bar.");
				tableNoted = true;
			}
			continue;
		}
		if (/^([-*_])\1{2,}$/.test(line)) continue; // horizontal rule
		lines.push(inline(line.replace(/^#{1,6}\s+/, "").replace(/^>\s?/, "").replace(/^([-*+]|\d+[.)])\s+/, "")));
	}
	return lines
		.filter((l) => l.length > 0)
		.join("\n")
		.trim();
}

function inline(text: string): string {
	return text
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images: alt text
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links: their text
		.replace(/<?https?:\/\/[^\s>)]*[^\s>).,;:!?]>?/g, "a link")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s.,;:!?)]|$)/g, "$1$2")
		.replace(/~~(.+?)~~/g, "$1")
		.replace(/<[^>]+>/g, "")
		.trim();
}
