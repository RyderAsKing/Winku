import { expect, test } from "bun:test";
import { MoodStripper, stripMood } from "../src/mood.ts";

function stream(chunks: string[]) {
	const s = new MoodStripper();
	const shown = chunks.map((c) => s.push(c));
	return { shown, ...s.finish() };
}

test("strips a trailing tag and reports the mood", () => {
	expect(stripMood("Done! <mood:happy>")).toEqual({ text: "Done!", mood: "happy" });
	expect(stripMood("Done!\n<mood:hearts>\n")).toEqual({ text: "Done!", mood: "hearts" });
	expect(stripMood("No tag here.")).toEqual({ text: "No tag here.", mood: undefined });
});

test("unknown moods are stripped and ignored", () => {
	expect(stripMood("Hm. <mood:grumpy>")).toEqual({ text: "Hm.", mood: undefined });
});

test("never leaks tag characters at any split point", () => {
	const full = "Sure, here you go. <mood:surprised>";
	for (let i = 0; i <= full.length; i++) {
		for (let j = i; j <= full.length; j++) {
			const { shown, text, mood } = stream([full.slice(0, i), full.slice(i, j), full.slice(j)]);
			expect(shown.join("")).toBe("Sure, here you go.");
			expect(text).toBe("Sure, here you go.");
			expect(mood).toBe("surprised");
		}
	}
});

test("one character at a time", () => {
	const { shown, text, mood } = stream([..."a < b, <mood:sad>"]);
	expect(shown.join("")).toBe("a < b,");
	expect(text).toBe("a < b,");
	expect(mood).toBe("sad");
});

test("text that only looks like the start of a tag is released", () => {
	const s = new MoodStripper();
	expect(s.push("x <mo")).toBe("x");
	expect(s.push("re text")).toBe(" <more text");
	expect(s.finish()).toEqual({ text: "x <more text", mood: undefined });
});

test("drops a dangling partial tag at the end of the stream", () => {
	expect(stream(["Bye <mood:ha"]).text).toBe("Bye");
});

test("a tag in the middle is removed, the last valid mood wins", () => {
	expect(stripMood("a <mood:sad>b <mood:happy>")).toEqual({ text: "a b", mood: "happy" });
});
