import { expect, test } from "bun:test";
import { BUBBLE_RADIUS, bubbleLinger, CHIP_H, dimsFor, GAP, SIZES, STRIP, shapesFor, stageSize } from "../src/main/stage.ts";

const small = SIZES.small;
const rightBelow = { alignRight: true, above: false };

test("the stage fits the strip, the widened bar and the tallest bubble", () => {
	expect(stageSize(small)).toEqual({ w: 640, h: STRIP + 56 + GAP + 360 });
});

test("the widened bar is at most half the monitor, and never narrower than the bar", () => {
	expect(dimsFor("small", 1920).wideW).toBe(640);
	expect(dimsFor("medium", 1366).wideW).toBe(683);
	expect(dimsFor("large", 800).wideW).toBe(560);
});

test("a resting pill on the right sits in the stage's top-right corner, under the strip", () => {
	expect(shapesFor(small, rightBelow, { headW: small.pillW, headH: small.pillH, bubbleH: 0 })).toEqual([{ x: 548, y: STRIP, w: 92, h: 56, r: 28 }]);
});

test("the bubble hangs under the bar, or over it low on the screen", () => {
	const below = shapesFor(small, { alignRight: false, above: false }, { headW: small.barW, headH: small.pillH, bubbleH: 120 });
	expect(below).toEqual([
		{ x: 0, y: STRIP, w: 400, h: 56, r: 28 },
		{ x: 0, y: STRIP + 56 + GAP, w: 400, h: 120, r: BUBBLE_RADIUS },
	]);
	const above = shapesFor(small, { alignRight: true, above: true }, { headW: small.pillW, headH: small.pillH, bubbleH: 120 });
	const stage = stageSize(small);
	expect(above[0]).toEqual({ x: 548, y: stage.h - STRIP - 56, w: 92, h: 56, r: 28 });
	expect(above[1]).toEqual({ x: 240, y: stage.h - STRIP - 56 - GAP - 120, w: 400, h: 120, r: BUBBLE_RADIUS });
});

test("scrolled back, the bubble is the wide width, still growing from the eyes' side", () => {
	const right = shapesFor(small, rightBelow, { headW: small.wideW, headH: small.pillH, bubbleH: 300, bubbleW: small.wideW });
	expect(right[1]).toEqual({ x: 0, y: STRIP + 56 + GAP, w: 640, h: 300, r: BUBBLE_RADIUS });
});

test("the floating meter sits in the strip on the pill's far side, at the eyes' end", () => {
	const top = shapesFor(small, rightBelow, { headW: small.barW, headH: small.pillH, bubbleH: 0, stripW: 150 });
	expect(top[1]).toEqual({ x: 640 - 150, y: 0, w: 150, h: CHIP_H, r: CHIP_H / 2 });
	const low = shapesFor(small, { alignRight: false, above: true }, { headW: small.barW, headH: small.pillH, bubbleH: 0, stripW: 150 });
	expect(low[1]).toEqual({ x: 0, y: stageSize(small).h - CHIP_H, w: 150, h: CHIP_H, r: CHIP_H / 2 });
});

test("a long bubble is capped at the stage, where it scrolls", () => {
	const [, bubble] = shapesFor(small, rightBelow, { headW: small.barW, headH: small.pillH, bubbleH: 2000 });
	expect(bubble?.h).toBe(small.bubbleMax);
});

test("a bubble under the resting pill lingers longer for longer replies, within limits", () => {
	expect(bubbleLinger("")).toBe(8000);
	expect(bubbleLinger("one two three")).toBe(8360);
	expect(bubbleLinger("word ".repeat(1000))).toBe(30_000);
});
