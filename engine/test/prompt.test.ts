import { expect, test } from "bun:test";
import { formatNow, parseNow } from "../src/nowline.ts";
import { buildSystemPrompt } from "../src/prompt.ts";

test("is deterministic for the same inputs (stable across turns)", () => {
	const inputs = { assistantStyle: "Warm and short." };
	const a = buildSystemPrompt(inputs);
	expect(buildSystemPrompt({ ...inputs })).toBe(a);
	expect(buildSystemPrompt(inputs)).toBe(a);
});

test("holds the instructions, style and mood instruction, and nothing time-varying", () => {
	const prompt = buildSystemPrompt({ assistantStyle: "Warm and short." });
	expect(prompt).toContain("You are Winku");
	expect(prompt).toContain("<assistant_style>\nWarm and short.\n</assistant_style>");
	expect(prompt).toContain("<mood:NAME>");
	expect(prompt).toContain("happy, hearts, neutral, sad, surprised, thinking");
	expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
	expect(buildSystemPrompt({ assistantStyle: "  " })).not.toContain("assistant_style");
});

test("has slots for about-me, voice profiles and the memory index", () => {
	const prompt = buildSystemPrompt({
		assistantStyle: "",
		aboutMe: "I live in Berlin.",
		voiceProfiles: [
			{ name: "work", content: "Formal." },
			{ name: "casual", content: "Loose." },
		],
		memoryIndex: "- likes tea",
	});
	expect(prompt).toContain("<about_me>\nI live in Berlin.\n</about_me>");
	expect(prompt.indexOf('name="casual"')).toBeLessThan(prompt.indexOf('name="work"'));
	expect(prompt).toContain("<memory_index>\n- likes tea\n</memory_index>");
	expect(prompt.trimEnd().endsWith("Never mention it.")).toBe(true);
});

test("now line round-trips", () => {
	const now = { app: "code.exe", windowTitle: 'a "b" <c>', selection: "x < y && z" };
	const text = `hello${formatNow(now)}`;
	expect(text).toBe('hello\n\n<now app="code.exe" window="a &quot;b&quot; &lt;c&gt;">x &lt; y &amp;&amp; z</now>');
	expect(parseNow(text)).toEqual({ text: "hello", now });
	expect(formatNow({})).toBe("");
	expect(parseNow("plain")).toEqual({ text: "plain" });
});
