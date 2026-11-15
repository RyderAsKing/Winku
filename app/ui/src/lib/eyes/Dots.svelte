<script lang="ts">
	// The dot field behind the pill's face (dots.ts says what lights up). One small canvas, drawn
	// only while something is playing: at idle it is cleared and no frame runs.
	import { untrack } from "svelte";
	import { alphaFor, baseField, BURST_MS, burstColour, burstField, DOT, type DotBurst, dotBurstFor, dotLoopFor, type Field, loopField, PITCH, quiet } from "./dots.ts";
	import type { EyeState } from "./look.ts";

	interface Props {
		/** The face's size, px: the pill, or the open bar. */
		width: number;
		height: number;
		/** The eyes' box, in the anchored corner. */
		pillW: number;
		pillH: number;
		alignRight: boolean;
		above: boolean;
		expression: EyeState;
		/** The eyes' colour now. */
		colour: string;
		/** Loops allowed (the bar shows, motion allowed). */
		animate: boolean;
		reduceMotion: boolean;
		/** Microphone level while listening, 0…1. */
		level?: number;
	}

	let { width, height, pillW, pillH, alignRight, above, expression, colour, animate, reduceMotion, level = 0 }: Props = $props();

	let canvas: HTMLCanvasElement | undefined = $state();
	interface Running {
		kind: DotBurst;
		start: number;
		colour: string;
		strength: number;
	}
	let bursts: Running[] = [];
	let frame = 0;
	let started = 0;

	const loop = $derived(animate && !reduceMotion ? dotLoopFor(expression) : null);

	/** Play a one-off burst, in `tone` (default: the eyes' colour). */
	export function burst(kind: DotBurst, { tone, strength = 1 }: { tone?: string; strength?: number } = {}) {
		if (reduceMotion) return;
		bursts.push({ kind, start: performance.now(), colour: tone ?? burstColour(kind) ?? colour, strength });
		kick();
	}

	// A new state: its burst, if it has one.
	let last: EyeState | null = null;
	$effect(() => {
		const now = expression;
		const from = last;
		last = now;
		const kind = from !== null && from !== now ? dotBurstFor(now) : null;
		if (kind) untrack(() => burst(kind));
	});

	$effect(() => {
		void loop;
		void width;
		void height;
		untrack(kick);
	});

	function kick() {
		if (!frame) frame = requestAnimationFrame(draw);
	}

	function draw(now: number) {
		frame = 0;
		const el = canvas;
		const ctx = el?.getContext("2d");
		if (!el || !ctx) return;
		const dpr = window.devicePixelRatio || 1;
		const w = Math.ceil(width);
		const h = Math.ceil(height);
		if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
			el.width = Math.round(w * dpr);
			el.height = Math.round(h * dpr);
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);

		bursts = bursts.filter((b) => now - b.start < BURST_MS[b.kind]);
		if (!loop && bursts.length === 0) {
			started = 0;
			return;
		}
		if (loop && !started) started = now;

		const ex = alignRight ? w - pillW / 2 : pillW / 2;
		const ey = above ? h - pillH / 2 : pillH / 2;
		const field: Field = { length: Math.max(w - pillW / 2, 1), half: h / 2, level, strength: 1 };
		const cols = Math.floor(w / PITCH);
		const rows = Math.floor(h / PITCH);
		const ox = (w - (cols - 1) * PITCH) / 2;
		const oy = (h - (rows - 1) * PITCH) / 2;

		const layers: { colour: string; at: (ax: number, ay: number) => number; base?: boolean }[] = [];
		if (loop) {
			const t = (now - started) / 1000;
			const kind = loop;
			layers.push({ colour, at: (ax, ay) => loopField(kind, ax, ay, t, field), base: true });
		}
		for (const b of bursts) {
			const p = (now - b.start) / BURST_MS[b.kind];
			const f = { ...field, strength: b.strength };
			layers.push({ colour: b.colour, at: (ax, ay) => burstField(b.kind, ax, ay, p, f) });
		}

		// Bucketed by brightness so each layer is a few fills, not one per dot. The brightest
		// dots go white at the core, like a lit pixel.
		const STEPS = 8;
		for (const layer of layers) {
			const buckets: number[][] = Array.from({ length: STEPS }, () => []);
			// While a loop runs, the unlit dots show faintly too: the matrix is on.
			const unlit: number[][] = Array.from({ length: STEPS }, () => []);
			for (let i = 0; i < cols; i++) {
				const x = ox + i * PITCH;
				const ax = alignRight ? ex - x : x - ex;
				for (let j = 0; j < rows; j++) {
					const y = oy + j * PITCH;
					const b = layer.at(ax, y - ey) * quiet(ax, pillW / 2);
					if (b < 0.04) {
						if (layer.base) unlit[Math.min(STEPS - 1, Math.floor(baseField(ax, field) * quiet(ax, pillW / 2) * STEPS))]?.push(x, y);
						continue;
					}
					buckets[Math.min(STEPS - 1, Math.floor(b * STEPS))]?.push(x, y);
				}
			}
			for (let s = 0; s < STEPS; s++) {
				const b = (s + 0.5) / STEPS;
				dotsAt(ctx, unlit[s], (DOT / 2) * 0.7, 0.08 * b, layer.colour);
				// Only the brightest dots, which are by the eyes, go white at the core.
				dotsAt(ctx, buckets[s], (DOT / 2) * (0.75 + 0.45 * b), alphaFor(b), b > 0.85 ? "#ffffff" : layer.colour);
			}
		}
		ctx.globalAlpha = 1;
		kick();
	}

	function dotsAt(ctx: CanvasRenderingContext2D, points: number[] | undefined, r: number, alpha: number, fill: string) {
		if (!points?.length || alpha < 0.01) return;
		ctx.globalAlpha = alpha;
		ctx.fillStyle = fill;
		ctx.beginPath();
		for (let k = 0; k < points.length; k += 2) {
			const x = points[k] ?? 0;
			const y = points[k + 1] ?? 0;
			ctx.moveTo(x + r, y);
			ctx.arc(x, y, r, 0, Math.PI * 2);
		}
		ctx.fill();
	}

	$effect(() => () => cancelAnimationFrame(frame));
</script>

<canvas
	class="dots"
	class:right={alignRight}
	class:above
	bind:this={canvas}
	style:width="{Math.ceil(width)}px"
	style:height="{Math.ceil(height)}px"
	aria-hidden="true"
></canvas>

<style>
	/* Behind everything on the face, pinned to the eyes' corner like the eyes. */
	.dots {
		position: absolute;
		top: 0;
		left: 0;
		pointer-events: none;
	}
	.right {
		left: auto;
		right: 0;
	}
	.above {
		top: auto;
		bottom: 0;
	}
</style>
