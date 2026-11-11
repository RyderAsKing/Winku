import { expect, test } from "bun:test";
import { shouldSpeak, speakable } from "../src/lib/speech.ts";

test("mirror speaks only spoken prompts; the other modes ignore how you asked", () => {
	expect(shouldSpeak("mirror", true)).toBe(true);
	expect(shouldSpeak("mirror", false)).toBe(false);
	expect(shouldSpeak("always_voice", false)).toBe(true);
	expect(shouldSpeak("always_text", true)).toBe(false);
});

test("markdown becomes plain sentences", () => {
	expect(speakable("## Steps\n\n1. Open **Settings**\n- Pick `Voice`\n> quoted")).toBe("Steps\nOpen Settings\nPick Voice\nquoted");
	expect(speakable("See [the docs](https://example.com) or https://example.org/x.")).toBe("See the docs or a link.");
	expect(speakable("It is *really* _fine_, snake_case_name stays.")).toBe("It is really fine, snake_case_name stays.");
});

test("code blocks and tables are mentioned once, not read", () => {
	const reply = "Run this:\n\n```ps1\nGet-ChildItem\n```\n\nand this:\n\n```\nls\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nDone.";
	expect(speakable(reply)).toBe("Run this:\nThe code is in the bar.\nand this:\nThe table is in the bar.\nDone.");
});
