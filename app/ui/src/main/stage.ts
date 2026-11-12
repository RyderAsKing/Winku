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
	/** Tallest the bubble gets before it scrolls; the transcript uses all of it. */
	bubbleMax: number;
	/** Input text size. */
	font: number;
}

export const SIZES: Record<EyeSize, Dims> = {
	small: { pillW: 92, pillH: 56, eye: 20, spacing: 27, barW: 400, bubbleMax: 360, font: 14 },
	medium: { pillW: 116, pillH: 70, eye: 25, spacing: 33, barW: 480, bubbleMax: 420, font: 15 },
	large: { pillW: 140, pillH: 84, eye: 30, spacing: 40, barW: 560, bubbleMax: 480, font: 15 },
};

/** Space between the bar (or pill) and the bubble. */
export const GAP = 8;

/** The bubble's corner radius; App.svelte's .bubble matches it. */
export const BUBBLE_RADIUS = 18;

export const DEFAULT_LAYOUT: Layout = { alignRight: true, above: false };

export function dimsFor(size: EyeSize | undefined): Dims {
	return SIZES[size ?? "small"] ?? SIZES.small;
}

export function stageSize(d: Dims): { w: number; h: number } {
	return { w: d.barW, h: d.pillH + GAP + d.bubbleMax };
}

/** Lines of a message the bar grows to show before the message box scrolls. */
export const INPUT_LINES = 4;

/** Space above and below the message box in a bar that has grown past the pill's height. */
export const INPUT_PAD = 12;

/** The bar's height for message-box content `inputH` tall: the pill's, or more for a long message. */
export function headHeight(d: Dims, inputH: number): number {
	return Math.max(d.pillH, Math.ceil(inputH) + 2 * INPUT_PAD);
}

/** The head (pill or open bar) and, when showing, the bubble, in stage coordinates. A bar taller
 * than the pill takes its extra height from the bubble's room. `headRoom`: the height to outline
 * for the head, more than `headH` while a bar that is getting shorter is still drawn taller. */
export function shapesFor(d: Dims, layout: Layout, headW: number, headH: number, bubbleH: number, headRoom = headH): Shape[] {
	const stage = stageSize(d);
	const x = (w: number) => (layout.alignRight ? stage.w - w : 0);
	const head: Shape = { x: x(headW), y: layout.above ? stage.h - headRoom : 0, w: headW, h: headRoom, r: d.pillH / 2 };
	if (bubbleH <= 0) return [head];
	const h = Math.min(Math.ceil(bubbleH), stage.h - headH - GAP);
	const y = layout.above ? stage.h - headH - GAP - h : headH + GAP;
	return [head, { x: x(d.barW), y, w: d.barW, h, r: BUBBLE_RADIUS }];
}

/** How long a reply bubble under the resting pill stays after the reply and its speech end. */
export function bubbleLinger(text: string): number {
	const words = text.trim() ? text.trim().split(/\s+/).length : 0;
	return Math.min(8000 + words * 120, 30_000);
}
