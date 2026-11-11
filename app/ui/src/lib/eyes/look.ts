// What the eyes look like in each state. Design reference: docs/research/eyes-prototype.js.
import type { Mood, ThinkingLevel } from "../../../../../engine/src/protocol.ts";

export type EyeState =
	| "idle"
	| "listening"
	| "thinking"
	| "speaking"
	| "happy"
	| "hearts"
	| "sad"
	| "surprised"
	| "pondering"
	| "error"
	| "cleared"
	| "sleeping";

/** Short looks shown after a reply finishes. */
export type MoodLook = "happy" | "hearts" | "sad" | "surprised" | "pondering";

export type EyeShape = "rect" | "arc" | "heart" | "crescent";

/** Resting tint by thinking level (SPEC §4). State colours take over during activity. */
export const TINTS: Record<ThinkingLevel, string> = {
	off: "#C4FFE8",
	minimal: "#A8FBEA",
	low: "#86F3F2",
	medium: "#5EF6F0",
	high: "#3CC6FF",
	xhigh: "#5A9CFF",
	max: "#7C7CFF",
};

const STATE_COLOURS: Partial<Record<EyeState, string>> = {
	listening: "#4CFFE3",
	thinking: "#FFD56A",
	speaking: "#C9B8FF",
	error: "#FF8B82",
	cleared: "#E7FFFB",
	sleeping: "#8ED8D3",
};

export interface Look {
	colour: string;
	shape: EyeShape;
	/** Eye scale relative to the resting size. */
	scale: number;
	/** Whole-pair rotation in degrees. */
	tilt: number;
	/** Per-eye rotation in degrees: [left, right]. */
	slant: [number, number];
	/** Gaze offset in eye-size units. */
	gaze: [number, number];
	/** Fraction of the eye height kept visible (error squints). */
	open: number;
	blush: boolean;
	ring: boolean;
	tear: boolean;
	/** Continuous loop, only while the bar is showing and motion is allowed. */
	loop: "none" | "pulse" | "bounce";
}

export function lookFor(state: EyeState, tint: string): Look {
	const base: Look = {
		colour: STATE_COLOURS[state] ?? tint,
		shape: "rect",
		scale: 1,
		tilt: 0,
		slant: [0, 0],
		gaze: [0, 0],
		open: 1,
		blush: false,
		ring: false,
		tear: false,
		loop: "none",
	};
	switch (state) {
		case "listening":
			return { ...base, scale: 1.12, ring: true, loop: "pulse" };
		case "thinking":
			return { ...base, tilt: -13, slant: [-4, 6], gaze: [0.12, -0.13] };
		case "speaking":
			return { ...base, loop: "bounce" };
		case "happy":
			return { ...base, shape: "arc", blush: true };
		case "hearts":
			return { ...base, shape: "heart", blush: true };
		case "sad":
			// Outer corners droop: the opposite slant to the error frown, no colour change.
			return { ...base, slant: [12, -12], gaze: [0, 0.1], open: 0.82 };
		case "surprised":
			return { ...base, scale: 1.16, gaze: [0, -0.06] };
		case "pondering":
			// The thinking pose in the resting tint, for a reply that ends on an open question.
			return { ...base, tilt: -9, gaze: [0.1, -0.11] };
		case "error":
			return { ...base, slant: [-16, 16], gaze: [0, 0.06], open: 0.78, tear: true };
		case "cleared":
			return { ...base, scale: 1.12 };
		case "sleeping":
			return { ...base, shape: "crescent" };
		default:
			return base;
	}
}

/** The transient look for a finished reply, before the hearts cooldown. */
export function moodLook(mood: Mood | undefined, userSaidThanks: boolean): MoodLook | null {
	switch (mood) {
		case undefined:
			return userSaidThanks ? "hearts" : "happy";
		case "neutral":
			return null;
		case "thinking":
			return "pondering";
		default:
			return mood;
	}
}

/** Hearts are kept rare (SPEC §4): at most once in this long. */
export const HEARTS_COOLDOWN_MS = 15 * 60_000;

export class HeartsGate {
	#last = Number.NEGATIVE_INFINITY;

	/** True if hearts may show now; records the showing. */
	take(now: number): boolean {
		if (now - this.#last < HEARTS_COOLDOWN_MS) return false;
		this.#last = now;
		return true;
	}
}

/** The look after a reply once the hearts cooldown applies: hearts too soon become happy. */
export function afterReply(look: MoodLook | null, hearts: HeartsGate, now: number): MoodLook | null {
	if (look === "hearts" && !hearts.take(now)) return "happy";
	return look;
}

/** The fallback rule for hearts: the user said thanks. */
export function saysThanks(text: string): boolean {
	return /\b(thanks|thank you|thx|ty|cheers|much appreciated)\b/i.test(text);
}

/** Lids lower gradually once context passes 20%, up to 30% closed at the limit (SPEC §4). */
export function lidFor(contextPercent: number | null): number {
	if (contextPercent === null) return 0;
	return 0.3 * Math.min(1, Math.max(0, (contextPercent - 20) / 80)) ** 1.3;
}
