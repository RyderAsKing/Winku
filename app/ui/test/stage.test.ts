import { expect, test } from "bun:test";
import { bubbleLinger, GAP, SIZES, shapesFor, stageSize } from "../src/main/stage.ts";

const small = SIZES.small;

test("the stage fits the open bar and the tallest bubble", () => {
	expect(stageSize(small)).toEqual({ w: 400, h: 56 + GAP + 360 });
});

test("a resting pill on the right sits in the stage's top-right corner", () => {
	expect(shapesFor(small, { alignRight: true, above: false }, small.pillW, 0)).toEqual([{ x: 308, y: 0, w: 92, h: 56 }]);
});

test("the bubble hangs under the bar, or over it low on the screen", () => {
	const below = shapesFor(small, { alignRight: false, above: false }, small.barW, 120);
	expect(below).toEqual([
		{ x: 0, y: 0, w: 400, h: 56 },
		{ x: 0, y: 64, w: 400, h: 120 },
	]);
	const above = shapesFor(small, { alignRight: true, above: true }, small.pillW, 120);
	const stage = stageSize(small);
	expect(above[0]).toEqual({ x: 308, y: stage.h - 56, w: 92, h: 56 });
	expect(above[1]).toEqual({ x: 0, y: stage.h - 56 - GAP - 120, w: 400, h: 120 });
});

test("a long bubble is capped at the stage, where it scrolls", () => {
	const [, bubble] = shapesFor(small, { alignRight: true, above: false }, small.barW, 2000);
	expect(bubble?.h).toBe(small.bubbleMax);
});

test("a bubble under the resting pill lingers longer for longer replies, within limits", () => {
	expect(bubbleLinger("")).toBe(8000);
	expect(bubbleLinger("one two three")).toBe(8360);
	expect(bubbleLinger("word ".repeat(1000))).toBe(30_000);
});
