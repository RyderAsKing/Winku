<script lang="ts">
	// The eyes. Each eye is its own compositor layer (will-change: transform), so the glow is
	// rasterised once per state and every animation only moves transform or opacity.
	// Continuous loops run only while `animate` is true; everything else is a one-off.
	import { lookFor, type EyeState } from "./look.ts";

	interface Props {
		expression: EyeState;
		tint: string;
		/** 0 = wide open, up to about 0.3 when context is full. */
		lid?: number;
		/** Eye body size in px. */
		eyeSize: number;
		/** Distance between eye centres in px. */
		spacing: number;
		/** A voice model downloading, 0…1: the eyes fill from the bottom. null = not downloading. */
		progress?: number | null;
		/** Allow continuous loops (pulse, bounce). */
		animate?: boolean;
		reduceMotion?: boolean;
	}

	let { expression, tint, lid = 0, progress = null, eyeSize, spacing, animate = false, reduceMotion = false }: Props = $props();

	const uid = $props.id();
	const look = $derived(lookFor(expression, tint));
	const box = $derived((eyeSize * 108) / 68);
	const width = $derived(spacing + box);
	const loop = $derived(animate && !reduceMotion ? look.loop : "none");
	// Lid edge in % of the eye box; a soft mask rather than a dark cap, so it works on any face.
	const lidEdge = $derived(lid > 0.01 && look.shape === "rect" ? ((14 + lid * 68) / 108) * 100 : 0);
	// Download progress: the lit part rises through the eye body (20..88 of the box); the rest is dim.
	const fillEdge = $derived(progress === null ? null : ((20 + Math.min(Math.max(progress, 0), 1) * 68) / 108) * 100);
	const lidMask = $derived(
		fillEdge !== null
			? `linear-gradient(to top, #000 ${fillEdge}%, rgb(0 0 0 / 0.22) ${fillEdge}%)`
			: lidEdge
				? `linear-gradient(to bottom, transparent ${lidEdge}%, #000 ${lidEdge + 7}%)`
				: "none",
	);
	const label = $derived(
		progress === null ? `Winku is ${expression}` : `Downloading a voice model, ${Math.round(Math.min(Math.max(progress, 0), 1) * 100)}%`,
	);

	// The eye body sits in 20..88 of a 108-unit box; the margin leaves room for the glow.
	const C = 54;
	const bodyH = $derived(68 * look.open);
	const bodyY = $derived(20 + (68 - bodyH) * 0.35);

	function filledArc(cx: number, cy: number, w: number, h: number, t: number): string {
		const l = cx - w / 2;
		const r = cx + w / 2;
		return `M ${l} ${cy} Q ${cx} ${cy - h} ${r} ${cy} Q ${cx} ${cy - h + t} ${l} ${cy} Z`;
	}

	function heartPath(cx: number, cy: number, s: number): string {
		const p = (dx: number, dy: number) => `${cx + s * dx} ${cy + s * dy}`;
		return [
			`M ${p(0, 0.38)}`,
			`C ${p(-0.08, 0.18)}, ${p(-0.52, -0.02)}, ${p(-0.48, -0.22)}`,
			`C ${p(-0.44, -0.46)}, ${p(-0.16, -0.48)}, ${p(0, -0.22)}`,
			`C ${p(0.16, -0.48)}, ${p(0.44, -0.46)}, ${p(0.48, -0.22)}`,
			`C ${p(0.52, -0.02)}, ${p(0.08, 0.18)}, ${p(0, 0.38)} Z`,
		].join(" ");
	}

	// ── one-off animations ──
	let blinkers: HTMLElement[] = $state([]);
	let glancer: HTMLElement | undefined = $state();

	function play(targets: (HTMLElement | undefined)[], keyframes: Keyframe[], duration: number) {
		if (reduceMotion) return;
		for (const el of targets) el?.animate(keyframes, { duration, easing: "ease-in-out" });
	}

	export function blink() {
		play(blinkers, [{ transform: "scaleY(1)" }, { transform: "scaleY(0.08)", offset: 0.45 }, { transform: "scaleY(1)" }], 300);
	}

	export function noted() {
		play(blinkers, [{ transform: "scaleY(1)" }, { transform: "scaleY(0.45)", offset: 0.5 }, { transform: "scaleY(1)" }], 220);
	}

	export function wipe() {
		play(
			blinkers,
			[
				{ transform: "scaleY(1)" },
				{ transform: "scaleY(0.04)", offset: 0.3 },
				{ transform: "scaleY(0.04)", offset: 0.45 },
				{ transform: "scaleY(1.06)", offset: 0.75 },
				{ transform: "scaleY(1)" },
			],
			900,
		);
	}

	export function yawn() {
		play(
			blinkers,
			[
				{ transform: "scaleY(1)" },
				{ transform: "scaleY(0.32)", offset: 0.3 },
				{ transform: "scaleY(0.32)", offset: 0.7 },
				{ transform: "scaleY(1)" },
			],
			1400,
		);
		play([glancer], [{ transform: "rotate(0deg)" }, { transform: "rotate(-5deg)", offset: 0.5 }, { transform: "rotate(0deg)" }], 1400);
	}

	export function glance() {
		const dx = (Math.random() < 0.5 ? -1 : 1) * eyeSize * 0.16;
		const dy = eyeSize * (Math.random() * 0.1 - 0.05);
		play(
			[glancer],
			[
				{ transform: "translate(0, 0)" },
				{ transform: `translate(${dx}px, ${dy}px)`, offset: 0.2 },
				{ transform: `translate(${dx}px, ${dy}px)`, offset: 0.8 },
				{ transform: "translate(0, 0)" },
			],
			1100,
		);
	}
</script>

<div
	class="eyes"
	class:still={reduceMotion}
	style:width="{width}px"
	style:height="{box}px"
	style:--c={look.colour}
	role="img"
	aria-label={label}
>
	<div
		class="pair {loop}"
		style:transform="rotate({look.tilt}deg) translate({look.gaze[0] * eyeSize}px, {look.gaze[1] * eyeSize}px)"
	>
		<div class="glancer" bind:this={glancer}>
			{#each [0, 1] as side}
				<div
					class="eye"
					style:left="{side === 0 ? 0 : spacing}px"
					style:width="{box}px"
					style:height="{box}px"
					style:transform="rotate({look.slant[side]}deg) scale({look.scale})"
				>
					<div class="blinker" bind:this={blinkers[side]}>
						<svg
							viewBox="0 0 108 108"
							width={box}
							height={box}
							style:mask-image={lidMask}
							style:-webkit-mask-image={lidMask}
							aria-hidden="true"
						>
							<defs>
								<linearGradient id="{uid}-fill-{side}" x1="0" y1="0" x2="0" y2="1">
									<stop offset="0%" stop-color="#FFFFFF" />
									<stop offset="22%" stop-color="#E8FFFC" />
									<stop offset="55%" stop-color={look.colour} />
									<stop offset="100%" stop-color={look.colour} />
								</linearGradient>
								<linearGradient id="{uid}-sheen-{side}" x1="0" y1="0" x2="0" y2="1">
									<stop offset="0%" stop-color="#fff" stop-opacity="0.95" />
									<stop offset="100%" stop-color="#fff" stop-opacity="0" />
								</linearGradient>
								<filter id="{uid}-bloom-{side}" x="-70%" y="-70%" width="240%" height="240%">
									<feGaussianBlur stdDeviation="5.5" result="b" />
									<feMerge>
										<feMergeNode in="b" />
										<feMergeNode in="b" />
										<feMergeNode in="SourceGraphic" />
									</feMerge>
								</filter>
							</defs>

							{#if look.shape === "rect"}
								{#if look.ring}
									<rect x="13" y={bodyY - 7} width="82" height={bodyH + 14} rx="25" fill="none" stroke={look.colour} stroke-width="2" opacity="0.35" />
								{/if}
								<rect x="20" y={bodyY} width="68" height={bodyH} rx="21" fill={look.colour} filter="url(#{uid}-bloom-{side})" opacity="0.9" />
								<rect x="20" y={bodyY} width="68" height={bodyH} rx="21" fill="url(#{uid}-fill-{side})" />
								<rect x="26" y={bodyY + 5} width="56" height={bodyH * 0.46} rx="14" fill="url(#{uid}-sheen-{side})" opacity="0.65" />
								<ellipse cx={C - 12} cy={bodyY + 18} rx="14" ry="10" fill="#fff" opacity="0.82" />
								<circle cx={C + 12} cy={bodyY + 24} r="3.2" fill="#fff" opacity="0.95" />
								{#if look.tear && side === 1}
									<path d="M 90 64 Q 96 76 88 82 Q 84 72 90 64 Z" fill="#7FD4FF" opacity="0.9" />
								{/if}
							{:else if look.shape === "arc"}
								<path d={filledArc(C, 68, 74, 46, 30)} fill={look.colour} filter="url(#{uid}-bloom-{side})" opacity="0.95" />
								<path d={filledArc(C, 68, 74, 46, 30)} fill="url(#{uid}-fill-{side})" />
								<path d={filledArc(C - 6, 58, 30, 14, 6)} fill="#fff" opacity="0.6" />
							{:else if look.shape === "heart"}
								<path d={heartPath(C, 56, 62)} fill={look.colour} filter="url(#{uid}-bloom-{side})" opacity="0.9" />
								<path d={heartPath(C, 56, 62)} fill="url(#{uid}-fill-{side})" />
								<ellipse cx={C - 13} cy="44" rx="9" ry="6.5" fill="#fff" opacity="0.88" />
								<circle cx={C + 12} cy="49" r="2.8" fill="#fff" opacity="0.95" />
							{:else}
								<path d={filledArc(C, 64, 72, 16, 11)} fill={look.colour} filter="url(#{uid}-bloom-{side})" opacity="0.85" />
								<path d={filledArc(C, 64, 72, 16, 11)} fill="url(#{uid}-fill-{side})" />
							{/if}
						</svg>
					</div>
				</div>
			{/each}
		</div>
	</div>

	<div class="blush" class:on={look.blush} style:--size="{eyeSize}px" aria-hidden="true">
		<span style:left="{box / 2 - eyeSize * 0.45}px"></span>
		<span style:left="{spacing + box / 2 + eyeSize * 0.45}px"></span>
	</div>
</div>

<style>
	.eyes {
		position: relative;
		flex: none;
	}
	.pair,
	.glancer {
		position: absolute;
		inset: 0;
		transform-origin: 50% 55%;
	}
	.pair {
		transition: transform 260ms ease;
	}
	.eye {
		position: absolute;
		top: 0;
		will-change: transform;
		transition: transform 260ms ease;
	}
	.blinker {
		width: 100%;
		height: 100%;
		transform-origin: 50% 50%;
	}
	svg {
		display: block;
		overflow: visible;

	}
	.still .pair,
	.still .eye,
	.still svg {
		transition: none;
	}

	.pair.pulse {
		animation: pulse 1.5s ease-in-out infinite;
	}
	.pair.bounce {
		animation: bounce 0.72s ease-in-out infinite;
	}
	@keyframes pulse {
		0%,
		100% {
			scale: 1;
		}
		50% {
			scale: 1.06;
		}
	}
	@keyframes bounce {
		0%,
		100% {
			translate: 0 0;
			scale: 1 1;
		}
		40% {
			translate: 0 -8%;
			scale: 1.05 0.93;
		}
		70% {
			translate: 0 2%;
			scale: 0.98 1.05;
		}
	}

	.blush span {
		position: absolute;
		top: 72%;
		width: calc(var(--size) * 0.64);
		height: calc(var(--size) * 0.3);
		translate: -50% 0;
		border-radius: 50%;
		background: #ff8aa8;
		filter: blur(calc(var(--size) * 0.1));
		opacity: 0;
		transition: opacity 300ms ease;
		will-change: opacity;
	}
	.blush.on span {
		opacity: 0.28;
	}
</style>
