// The main window is a fixed "stage" with the pill in one corner. The bar grows out of the pill
// and the reply bubble sits under it (or over it, low on the screen), both toward the middle of
// the monitor. The UI reports the shapes it draws; on Windows the shell clips the window to them.
import type { EyeSize } from "../lib/settings.ts";
import type { Layout, Shape } from "../lib/shell.ts";

export interface Dims {
	/** The resting pill. Keep in step with `EyeSize::pill` in app/src-tauri/src/window.rs. */
	pillW: number;
	pillH: number;
	/** Eye body size and the distance between eye centres. */
	eye: number;
	spacing: number;
	/** The open bar, and the bubble under it. */
	barW: number;
	/** Bar and bubble while scrolled back through the conversation: wider, to read it. The stage
	 * is this wide all the time, so widening only moves the clip edge. */
	wideW: number;
	/** Tallest the bubble gets before it scrolls; the transcript uses all of it. */
	bubbleMax: number;
	/** Input text size. */
	font: number;
}

export const SIZES: Record<EyeSize, Dims> = {
	small: { pillW: 92, pillH: 56, eye: 20, spacing: 27, barW: 400, wideW: 640, bubbleMax: 360, font: 14 },
	medium: { pillW: 116, pillH: 70, eye: 25, spacing: 33, barW: 480, wideW: 760, bubbleMax: 420, font: 15 },
	large: { pillW: 140, pillH: 84, eye: 30, spacing: 40, barW: 560, wideW: 880, bubbleMax: 480, font: 15 },
};

/** Space between the bar (or pill) and the bubble. */
export const GAP = 8;

/** Floating pills (attachments, and the meter and thinking level while typing) are this tall. */
export const CHIP_H = 32;

/** The strip on the pill's far side (above it, or below when the bubble goes above), where the
 * meter and thinking level float while you type: a row of pills and the gap to the bar. The
 * window keeps it on that side all the time; the shell says whether it is on screen. */
export const STRIP = CHIP_H + 6;

/** The bubble's corner radius; App.svelte's .bubble matches it. */
export const BUBBLE_RADIUS = 18;

export const DEFAULT_LAYOUT: Layout = { alignRight: true, above: false, room: true };

/** `screenW`: the monitor's width. The pill is always on the half the stage grows away from, so a
 * stage no wider than half the monitor stays on it. */
export function dimsFor(size: EyeSize | undefined, screenW = Infinity): Dims {
	const d = SIZES[size ?? "small"] ?? SIZES.small;
	return { ...d, wideW: Math.max(d.barW, Math.min(d.wideW, Math.floor(screenW / 2))) };
}

export function stageSize(d: Dims): { w: number; h: number } {
	return { w: d.wideW, h: STRIP + d.pillH + GAP + d.bubbleMax };
}

/** Why the bar and bubble are Wide (GLOSSARY.md): reading back through the thread, or showing a
 * visual. */
export type WideReason = "browsing" | "visual";

/** The reasons the bar and bubble are Wide right now; none means their usual width.
 * `browsing`: scrolled back through the thread over the reply bubble (not the transcript).
 * `visual`: the reply bubble holds a visual. */
export function wideReasons(now: { browsing: boolean; visual: boolean }): WideReason[] {
	const reasons: WideReason[] = [];
	if (now.browsing) reasons.push("browsing");
	if (now.visual) reasons.push("visual");
	return reasons;
}

/** The bar and bubble's width: Wide for any reason, else the bar's usual width. */
export function barWidth(d: Dims, reasons: readonly WideReason[]): number {
	return reasons.length > 0 ? d.wideW : d.barW;
}

/** Lines of a message the bar grows to show before the message box scrolls. */
export const INPUT_LINES = 4;

/** Space above and below the message box in a bar that has grown past the pill's height. */
export const INPUT_PAD = 12;

/** The bar's height for message-box content `inputH` tall: the pill's, or more for a long message. */
export function headHeight(d: Dims, inputH: number): number {
	return Math.max(d.pillH, Math.ceil(inputH) + 2 * INPUT_PAD);
}

/** What is drawn besides the head. `bubbleH`: the bubble column's height, 0 when none.
 * `headRoom`: the height to outline for the head, more than `headH` while a bar that is getting
 * shorter is still drawn taller. `bubbleW`: the bubble's width, `wideW` while scrolled back.
 * `stripW`: the floating meter's width in the strip, 0 when it isn't there. */
export interface Drawn {
	headW: number;
	headH: number;
	bubbleH: number;
	headRoom?: number;
	bubbleW?: number;
	stripW?: number;
}

/** The head (pill or open bar), the floating meter in the strip and the bubble, in stage
 * coordinates. A bar taller than the pill takes its extra height from the bubble's room. */
export function shapesFor(d: Dims, layout: Layout, { headW, headH, bubbleH, headRoom = headH, bubbleW = d.barW, stripW = 0 }: Drawn): Shape[] {
	const stage = stageSize(d);
	const x = (w: number) => (layout.alignRight ? stage.w - w : 0);
	const shapes: Shape[] = [{ x: x(headW), y: layout.above ? stage.h - STRIP - headRoom : STRIP, w: headW, h: headRoom, r: d.pillH / 2 }];
	if (stripW > 0) shapes.push({ x: x(stripW), y: layout.above ? stage.h - CHIP_H : 0, w: stripW, h: CHIP_H, r: CHIP_H / 2 });
	if (bubbleH <= 0) return shapes;
	const h = Math.min(Math.ceil(bubbleH), stage.h - STRIP - headH - GAP);
	const y = layout.above ? stage.h - STRIP - headH - GAP - h : STRIP + headH + GAP;
	shapes.push({ x: x(bubbleW), y, w: bubbleW, h, r: BUBBLE_RADIUS });
	return shapes;
}

/** How long a reply bubble under the resting pill stays after the reply and its speech end.
 * null: it stays until dismissed (`Esc`, or a click elsewhere with the bar open), as a bubble
 * holding a visual does. */
export function bubbleLinger(text: string, held: { visual: boolean }): number | null {
	if (held.visual) return null;
	const words = text.trim() ? text.trim().split(/\s+/).length : 0;
	return Math.min(8000 + words * 120, 30_000);
}
