// The dot field behind the pill's face: a fine grid of dots that lights up with what Winku is
// doing, brightest by the eyes and fading along the bar. At idle it is blank and nothing runs.
// Loops run while the bar shows (the motion budget, SPEC §4); bursts are one-offs that mark an
// event. Everything here is pure: a dot's brightness (0…1) from where it is and when.
//
// A dot is placed by `ax`, how far along the bar it is from the eyes' centre (negative behind
// them), and `ay`, how far above (−) or below (+) their centre, both in px.
import type { EyeState } from "./look.ts";

/** Dot spacing and size, px. */
export const PITCH = 5;
export const DOT = 2.2;

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** How far the dots light up under the message and the meter, against around the eyes. */
export const UNDER_TEXT = 0.2;
/** The most a dot shows (its opacity), and the most under text: kept low enough that muted text
 * over a lit dot still reads at 4.5:1. */
export const MAX_ALPHA = 0.64;

/**
 * How brightly a dot may show at `ax`: in full around the eyes, where there is no text, easing
 * down within a few dots to UNDER_TEXT over the rest of the bar, so the message stays easy to read.
 * `eyes` is half the pill's width: the eyes' box ends there.
 */
export function quiet(ax: number, eyes: number): number {
	const t = clamp((ax - eyes + 6) / 18);
	return 1 - (1 - UNDER_TEXT) * t * t * (3 - 2 * t);
}

/** A dot's opacity for brightness `b` (0…1). */
export function alphaFor(b: number): number {
	return 0.04 + (MAX_ALPHA - 0.04) * b;
}

export interface Field {
	/** The bar's length from the eyes' centre to its far end, px. */
	length: number;
	/** Half the face's height, px. */
	half: number;
	/** Microphone level while listening, 0…1. */
	level: number;
	/** Burst strength, 0…1 (higher thinking levels sweep further and brighter). */
	strength: number;
}

export type DotLoop = "listening" | "thinking" | "speaking";
export type DotBurst = "happy" | "hearts" | "surprised" | "sad" | "error" | "cleared" | "level" | "calm";

export function dotLoopFor(state: EyeState): DotLoop | null {
	return state === "listening" || state === "thinking" || state === "speaking" ? state : null;
}

/** The burst when the eyes change to a state, if any. */
export function dotBurstFor(state: EyeState): DotBurst | null {
	switch (state) {
		case "happy":
		case "hearts":
		case "surprised":
		case "sad":
		case "error":
		case "cleared":
			return state;
		default:
			return null;
	}
}

export const BURST_MS: Record<DotBurst, number> = {
	happy: 900,
	hearts: 1200,
	surprised: 520,
	sad: 1500,
	error: 700,
	cleared: 800,
	level: 760,
	calm: 900,
};

/** A burst's own colour, or null for the eyes' colour. */
export function burstColour(kind: DotBurst): string | null {
	return kind === "hearts" ? "#FF8AA8" : null;
}

const smooth = (a: number, b: number, n: number) => {
	const t = clamp((n - a) / (b - a));
	return t * t * (3 - 2 * t);
};
/** Brighter by the eyes, fading toward the bar's far end. */
const falloff = (ax: number, f: Field) => clamp(1 - Math.max(0, ax) / Math.max(f.length, 1)) ** 1.4;
/** A soft ring of dots `r` px from the eyes' centre, `w` px thick. */
const ring = (d: number, r: number, w: number) => Math.exp(-(((d - r) / w) ** 2));

/** Some dots a little dimmer than their neighbours, so a lit patch reads as pixels. */
const grain = (ax: number, ay: number) => 0.55 + 0.45 * hash(Math.round(ax / PITCH), Math.round(ay / PITCH));

/** How brightly the resting grid shows while a loop runs: the matrix is on, nearest the eyes. */
export function baseField(ax: number, f: Field): number {
	return 0.5 * falloff(ax, f);
}

/** A repeatable 0…1 per grid cell, so patterns don't flicker at random. */
export function hash(x: number, y: number): number {
	const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
	return s - Math.floor(s);
}

/** Smooth value noise, 0…1. */
export function noise(x: number, y: number): number {
	const ix = Math.floor(x);
	const iy = Math.floor(y);
	const fx = x - ix;
	const fy = y - iy;
	const ux = fx * fx * (3 - 2 * fx);
	const uy = fy * fy * (3 - 2 * fy);
	const a = hash(ix, iy);
	const b = hash(ix + 1, iy);
	const c = hash(ix, iy + 1);
	const d = hash(ix + 1, iy + 1);
	return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** A loop's brightness at time `t` s. */
export function loopField(kind: DotLoop, ax: number, ay: number, t: number, f: Field): number {
	const d = Math.hypot(ax, ay);
	switch (kind) {
		// Hearing you: rings roll out from the eyes, stronger as you speak up.
		case "listening": {
			let b = 0;
			for (let k = 0; k < 3; k++) {
				const r = (t * 46 + k * 34) % 102;
				b = Math.max(b, ring(d, r + 14, 4) * (1 - r / 102));
			}
			return clamp(b * (0.35 + 0.65 * f.level) * falloff(ax, f));
		}
		// Thinking it over: specks drift away from the eyes along the bar, appearing and fading
		// like thoughts.
		case "thinking": {
			const n = noise(ax / 16 - t * 1.1, ay / 10 + t * 0.25);
			return clamp(smooth(0.55, 0.82, n) * falloff(ax, f) * grain(ax, ay));
		}
		// Talking: columns of dots rise and fall like a voice meter.
		case "speaking": {
			const col = Math.round(ax / PITCH);
			const swing = (0.5 + 0.5 * Math.sin(t * 9 + col * 0.7)) * (0.55 + 0.45 * Math.sin(t * 5.3 + col * 1.9));
			const reach = f.half * 0.85 * swing;
			// A quiet column is dark, not a dot on the centre line.
			return reach >= PITCH / 2 && Math.abs(ay) <= reach ? clamp(0.75 * falloff(ax, f) ** 1.6) : 0;
		}
	}
}

/** A burst's brightness at progress `p` (0…1). Every burst is dark again at p = 1. */
export function burstField(kind: DotBurst, ax: number, ay: number, p: number, f: Field): number {
	const d = Math.hypot(ax, ay);
	const fade = 1 - p;
	const reach = Math.max(f.length, 60);
	switch (kind) {
		// Pleased: a ring of dots bursts out from the eyes.
		case "happy":
			return clamp(ring(d, p * reach * 0.7, 7) * fade * 1.1);
		// Two rings, in pink.
		case "hearts":
			return clamp(Math.max(ring(d, p * reach * 0.75, 7), ring(d, Math.max(0, p - 0.22) * reach * 0.75, 6)) * fade * 1.1);
		// A start: one quick, tight ring.
		case "surprised":
			return clamp(ring(d, p * 70, 4) * fade * 1.2);
		// Sad: dots drip down and fade.
		case "sad": {
			const col = Math.round(ax / PITCH);
			if (hash(col, 7) > 0.35) return 0;
			const head = -f.half + (p * 1.6 - hash(col, 3) * 0.6) * f.half * 2;
			const tail = head - ay;
			return tail >= 0 && tail < 14 ? clamp((1 - tail / 14) * fade * 0.8 * falloff(ax, f)) : 0;
		}
		// Something broke: rows of dots glitch on and off.
		case "error": {
			const row = Math.round(ay / PITCH);
			const tick = Math.floor(p * 14);
			if (hash(row, tick) > 0.45) return 0;
			const from = hash(row, tick + 9) * reach;
			const span = 20 + hash(tick, row) * 70;
			return ax >= from && ax <= from + span ? clamp(0.8 * fade) : 0;
		}
		// A clean slate: a bright line sweeps away from the eyes and leaves nothing behind.
		case "cleared": {
			const front = p * (reach + 20);
			return clamp(Math.exp(-(((ax - front) / 5) ** 2)) * (1 - p * 0.4));
		}
		// Up a thinking level: the new colour sweeps along the bar with a trail, further and
		// brighter for higher levels.
		case "level": {
			const front = p * (reach * (0.5 + 0.6 * f.strength) + 20);
			if (ax > front) return 0;
			const trail = Math.exp(-(front - ax) / (18 + 40 * f.strength));
			return clamp(trail * (0.7 + 0.5 * f.strength) * (1 - p * p) * 1.5 * grain(ax, ay));
		}
		// Back to the bottom: the dots settle, drawing in toward the eyes and going out.
		case "calm": {
			const front = (1 - p) * reach * 0.6;
			return clamp(Math.exp(-(((d - front) / 10) ** 2)) * 0.45 * Math.sin(Math.PI * p));
		}
	}
}
