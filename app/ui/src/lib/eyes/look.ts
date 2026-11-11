// What the eyes look like in each state. Design reference: docs/research/eyes-prototype.js.
import type { ThinkingLevel } from "../../../../../engine/src/protocol.ts";

export type EyeState =
	| "idle"
	| "listening"
	| "thinking"
	| "speaking"
	| "happy"
	| "hearts"
	| "error"
	| "cleared"
	| "sleeping";

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
