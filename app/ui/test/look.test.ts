import { describe, expect, test } from "bun:test";
import { afterReply, HEARTS_COOLDOWN_MS, HeartsGate, lidFor, lookFor, moodLook, saysThanks, TINTS, type EyeState } from "../src/lib/eyes/look.ts";

describe("moodLook", () => {
	test("a mood tag picks the look", () => {
		expect(moodLook("happy", false)).toBe("happy");
		expect(moodLook("hearts", false)).toBe("hearts");
		expect(moodLook("sad", true)).toBe("sad");
		expect(moodLook("surprised", false)).toBe("surprised");
		expect(moodLook("thinking", false)).toBe("pondering");
	});
	test("neutral shows nothing", () => {
		expect(moodLook("neutral", true)).toBeNull();
	});
	test("without a tag: happy, or hearts after thanks", () => {
		expect(moodLook(undefined, false)).toBe("happy");
		expect(moodLook(undefined, true)).toBe("hearts");
	});
});

describe("hearts stay rare", () => {
	test("a second hearts inside the cooldown shows happy", () => {
		const gate = new HeartsGate();
		expect(afterReply("hearts", gate, 1_000)).toBe("hearts");
		expect(afterReply("hearts", gate, 1_000 + HEARTS_COOLDOWN_MS - 1)).toBe("happy");
		expect(afterReply("hearts", gate, 1_000 + HEARTS_COOLDOWN_MS)).toBe("hearts");
	});
	test("other looks don't use up the cooldown", () => {
		const gate = new HeartsGate();
		expect(afterReply("happy", gate, 0)).toBe("happy");
		expect(afterReply(null, gate, 0)).toBeNull();
		expect(afterReply("hearts", gate, 1)).toBe("hearts");
	});
});

test("saysThanks", () => {
	for (const yes of ["thanks!", "Thank you so much", "ty", "cheers mate", "thx"]) expect(saysThanks(yes)).toBe(true);
	for (const no of ["thanksgiving plans?", "they", "what's the theory", ""]) expect(saysThanks(no)).toBe(false);
});

describe("lidFor", () => {
	test("open until 20% context, about 30% closed at the limit", () => {
		expect(lidFor(null)).toBe(0);
		expect(lidFor(0)).toBe(0);
		expect(lidFor(20)).toBe(0);
		expect(lidFor(100)).toBeCloseTo(0.3);
		expect(lidFor(150)).toBeCloseTo(0.3);
	});
	test("lowers steadily", () => {
		const values = [30, 50, 70, 90].map(lidFor);
		for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1] as number);
	});
});

describe("lookFor", () => {
	const states: EyeState[] = ["idle", "listening", "thinking", "speaking", "happy", "hearts", "sad", "surprised", "pondering", "error", "cleared", "sleeping"];
	test("state colours from the spec take over from the tint", () => {
		expect(lookFor("listening", TINTS.max).colour).toBe("#4CFFE3");
		expect(lookFor("thinking", TINTS.max).colour).toBe("#FFD56A");
		expect(lookFor("speaking", TINTS.max).colour).toBe("#C9B8FF");
		expect(lookFor("error", TINTS.max).colour).toBe("#FF8B82");
	});
	test("idle and moods keep the resting tint", () => {
		for (const s of ["idle", "happy", "hearts", "sad", "surprised", "pondering"] as const) expect(lookFor(s, TINTS.high).colour).toBe(TINTS.high);
	});
	test("medium is the spec's cyan", () => {
		expect(TINTS.medium).toBe("#5EF6F0");
	});
	test("only listening and speaking loop", () => {
		for (const s of states) {
			const loop = lookFor(s, TINTS.medium).loop;
			expect(loop === "none").toBe(s !== "listening" && s !== "speaking");
		}
	});
	test("every state looks different", () => {
		const keys = states.map((s) => JSON.stringify(lookFor(s, TINTS.medium)));
		expect(new Set(keys).size).toBe(states.length);
	});
});
