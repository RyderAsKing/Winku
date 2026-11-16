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
	expect(prompt).toContain("Start the reply with <say>");
	expect(prompt).toContain("happy, hearts, neutral, sad, surprised, thinking");
	expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
	expect(buildSystemPrompt({ assistantStyle: "  " })).not.toContain("assistant_style");
});

test("has the memory block (about-me, profile, goals, recap, topics) and voice profiles", () => {
	const prompt = buildSystemPrompt({
		assistantStyle: "",
		aboutMe: "I live in Berlin.",
		voiceProfiles: [
			{ name: "work", content: "Formal." },
			{ name: "casual", content: "Loose." },
		],
		profile: "- Likes tea",
		goals: "- Ship 0.2 by Friday",
		recap: "Talked about the release.",
		noteTopics: ["food", "work"],
	});
	expect(prompt).toContain(
		"<winku_memory>\n<about_me>\nI live in Berlin.\n</about_me>\n<profile>\n- Likes tea\n</profile>\n<goals>\n- Ship 0.2 by Friday\n</goals>\n<recap>\nTalked about the release.\n</recap>\n<note_topics>\nfood, work\n</note_topics>\n</winku_memory>",
	);
	expect(prompt.indexOf('name="casual"')).toBeLessThan(prompt.indexOf('name="work"'));
	expect(prompt).toContain("Never say you don't know or can't remember".replace("Never", "never"));
	expect(prompt).toContain("<recalled_memories>");
	expect(prompt.trimEnd().endsWith("Never mention it.")).toBe(true);
	expect(buildSystemPrompt({ assistantStyle: "" })).toContain("<winku_memory>\n(nothing yet)\n</winku_memory>");
});

test("now line round-trips", () => {
	const now = { app: "code.exe", windowTitle: 'a "b" <c>', selection: "x < y && z" };
	const text = `hello${formatNow(now)}`;
	expect(text).toBe('hello\n\n<now app="code.exe" window="a &quot;b&quot; &lt;c&gt;">x &lt; y &amp;&amp; z</now>');
	expect(parseNow(text)).toEqual({ text: "hello", now });
	expect(formatNow({})).toBe("");
	expect(parseNow("plain")).toEqual({ text: "plain" });
});

test("a spoken prompt is marked on the now line and read back", () => {
	expect(formatNow(undefined, true)).toBe('\n\n<now spoken="yes"></now>');
	expect(formatNow(undefined, false, "brief")).toBe('\n\n<now speak="brief"></now>');
	expect(parseNow(`hi${formatNow(undefined, true, "full")}`)).toEqual({ text: "hi", spoken: true });
	expect(parseNow(`hi${formatNow(undefined, true)}`)).toEqual({ text: "hi", spoken: true });
	const now = { app: "notepad.exe", selection: "x" };
	expect(parseNow(`hi${formatNow(now, true)}`)).toEqual({ text: "hi", now, spoken: true });
	expect(parseNow(`hi${formatNow(now)}`)).toEqual({ text: "hi", now });
});

test("the tool list mentions the clipboard tools", () => {
	const prompt = buildSystemPrompt({ assistantStyle: "" });
	for (const name of ["clipboard_read", "clipboard_write", "clipboard_edit"]) expect(prompt).toContain(name);
});
