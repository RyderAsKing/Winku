import { expect, test } from "bun:test";
import { SayStripper, splitSay } from "../src/say.ts";

function stream(chunks: string[]) {
	const s = new SayStripper();
	const shown: string[] = [];
	const said: string[] = [];
	for (const chunk of chunks) {
		const out = s.push(chunk);
		shown.push(out.shown);
		said.push(...out.said);
	}
	const last = s.finish();
	shown.push(last.shown);
	said.push(...last.said);
	return { shown: shown.join(""), said };
}

const FULL = "<say>The fix is a one-line change to the timeout.</say>\n\nSet `timeout = 30` in `C:\\app\\config.toml`.";

test("the say block is said, the rest is shown without the blank line after it", () => {
	expect(splitSay(FULL)).toEqual({
		text: "Set `timeout = 30` in `C:\\app\\config.toml`.",
		said: ["The fix is a one-line change to the timeout."],
	});
});

test("never leaks tag characters at any split point", () => {
	for (let i = 0; i <= FULL.length; i++) {
		for (let j = i; j <= FULL.length; j++) {
			const { shown, said } = stream([FULL.slice(0, i), FULL.slice(i, j), FULL.slice(j)]);
			expect(shown).toBe("Set `timeout = 30` in `C:\\app\\config.toml`.");
			expect(said).toEqual(["The fix is a one-line change to the timeout."]);
		}
	}
});

test("a block is said as soon as it closes, before the written part streams", () => {
	const s = new SayStripper();
	expect(s.push("<say>Sure, one ")).toEqual({ shown: "", said: [] });
	expect(s.push("moment.</say>\n\nHere")).toEqual({ shown: "Here", said: ["Sure, one moment."] });
	expect(s.push(" it is.")).toEqual({ shown: " it is.", said: [] });
});

test("a reply that is only said shows nothing", () => {
	expect(splitSay("<say>It's twenty past three.</say>")).toEqual({ text: "", said: ["It's twenty past three."] });
});

test("several blocks, e.g. a short one before tools and the answer after", () => {
	expect(splitSay("<say>Let me check.</say>\n<say>It's sunny, 21 degrees.</say>\n\n**21 °C**, clear")).toEqual({
		text: "**21 °C**, clear",
		said: ["Let me check.", "It's sunny, 21 degrees."],
	});
});

test("an unclosed block still counts as said", () => {
	expect(splitSay("<say>Cut off mid")).toEqual({ text: "", said: ["Cut off mid"] });
});

test("text that only looks like a tag is shown", () => {
	expect(splitSay("a < b and <sa> is not a tag, nor <s>")).toEqual({ text: "a < b and <sa> is not a tag, nor <s>", said: [] });
	expect(splitSay("No tags at all.")).toEqual({ text: "No tags at all.", said: [] });
});

test("tags are matched in any case", () => {
	expect(splitSay("<SAY>Hi.</Say> there")).toEqual({ text: "there", said: ["Hi."] });
});

test("one character at a time", () => {
	const { shown, said } = stream([...FULL]);
	expect(shown).toBe("Set `timeout = 30` in `C:\\app\\config.toml`.");
	expect(said).toEqual(["The fix is a one-line change to the timeout."]);
});
