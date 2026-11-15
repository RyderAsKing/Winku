<script lang="ts">
	// The pill, and the bar it stretches into. The eyes never move: the bar grows from the pill
	// toward the middle of the screen. Click the eyes to open or close, drag them to move Winku,
	// right-click for the menu. Open: the message box, then the context meter and thinking level,
	// which float off the bar (App.svelte) once there is a message, so it has the whole bar.
	//
	// The eyes are pinned to the anchored corner and the body is laid out at the full bar width the
	// whole time, so opening and closing only move the clip edge: nothing inside reflows or slides.
	// A long message makes the bar taller, away from the eyes' row, up to INPUT_LINES; then the
	// message box scrolls.
	import { untrack } from "svelte";
	import { cubicOut } from "svelte/easing";
	import { fade } from "svelte/transition";
	import { ms } from "../lib/motion.ts";
	import Eyes from "../lib/eyes/Eyes.svelte";
	import Dots from "../lib/eyes/Dots.svelte";
	import { lookFor } from "../lib/eyes/look.ts";
	import Meta from "./Meta.svelte";
	import { shell } from "../lib/shell.ts";
	import { INPUT_LINES } from "./stage.ts";
	import type { MainState } from "./state.svelte.ts";

	/** `open`: the bar is showing. `height`: the bar's height, taller than the pill for a long message.
	 * `width`: the open bar's width, wider while scrolled back through the conversation. */
	let { app, open, height, width }: { app: MainState; open: boolean; height: number; width: number } = $props();

	let eyes: Eyes | undefined = $state();
	let dots: Dots | undefined = $state();
	let input: HTMLTextAreaElement | undefined = $state();
	let meta: HTMLElement | undefined = $state();
	let text = $state("");

	$effect(() => app.eyes.attach(eyes));

	// Due scheduled tasks wait while there is a draft (#43).
	$effect(() => app.setDraft(text.trim().length > 0));

	$effect(() => {
		void app.focusTick;
		input?.focus({ preventScroll: true });
	});

	const d = $derived(app.dims);
	const waiting = $derived(app.tasks.length);
	// While talking the box shows what has been heard; the typed draft comes back afterwards.
	const dictating = $derived(app.dictation !== null);
	const shown = $derived(app.dictation ?? text);
	// Travelling to the pointer, the eyes lean the way they are going.
	const lean = $derived.by(() => {
		const t = app.travelling;
		const far = t ? Math.hypot(t.dx, t.dy) : 0;
		if (!t || far === 0) return { x: 0, y: 0 };
		const reach = d.eye * 0.2;
		return { x: (t.dx / far) * reach, y: (t.dy / far) * reach * 0.6 };
	});
	const LINE = 1.45;
	const maxInput = $derived(Math.ceil(app.dims.font * LINE * INPUT_LINES));

	let start: { x: number; y: number } | null = null;

	// A press doesn't focus the eyes (onmousedown): focus stays in the message box while the bar is
	// dragged, and the next key press doesn't ring the eyes. Tab still reaches them.
	function onpointerdown(event: PointerEvent) {
		if (event.button !== 0) return;
		start = { x: event.screenX, y: event.screenY };
	}

	function onpointermove(event: PointerEvent) {
		if (!start) return;
		if (Math.hypot(event.screenX - start.x, event.screenY - start.y) > 3) {
			start = null;
			void shell.startDrag(event.pointerType);
		}
	}

	function onpointerup() {
		if (start) void (open ? app.hide() : app.summon());
		start = null;
	}

	function oncontextmenu(event: MouseEvent) {
		event.preventDefault();
		void shell.contextMenu();
	}

	function autosize() {
		if (!input) return;
		input.style.height = "auto";
		const full = input.scrollHeight;
		input.style.height = `${Math.min(full, maxInput)}px`;
		input.classList.toggle("scrolls", full > maxInput);
		// Spoken words arrive at the end: keep the end in view.
		if (dictating) input.scrollTop = input.scrollHeight;
	}

	$effect(() => {
		void shown;
		void maxInput;
		// The meter leaving the bar widens the box: fewer lines.
		void app.crowded;
		autosize();
	});

	// The meter and thinking level stay in the bar until the message reaches them, then float off
	// it (App.svelte) to give the message the whole bar. They come back once it is short again,
	// well clear of where they would sit, so they don't hop in and out at one width.
	let metaW = 0;
	let measurer: CanvasRenderingContext2D | null = null;
	$effect(() => {
		const value = shown;
		void width;
		void maxInput;
		untrack(() => {
			if (!input) return;
			if (!value.trim()) return void (app.crowded = false);
			if (value.includes("\n")) return void (app.crowded = true);
			if (meta) metaW = meta.offsetWidth;
			const room = input.clientWidth - (meta ? 0 : metaW);
			measurer ??= document.createElement("canvas").getContext("2d");
			if (!measurer) return;
			measurer.font = getComputedStyle(input).font;
			const used = measurer.measureText(value).width;
			if (!app.crowded && used > room - 16) app.crowded = true;
			else if (app.crowded && used < room - 56) app.crowded = false;
		});
	});

	// A new thinking level: the eyes perk up and the new colour sweeps along the face, more for
	// higher levels; back to the bottom, both settle. Not for the level the engine starts with.
	let lastLevel: { level: string; known: boolean } | null = null;
	$effect(() => {
		const level = app.thinking;
		const known = app.ready !== null;
		const from = lastLevel;
		lastLevel = { level, known };
		if (!from?.known || from.level === level) return;
		untrack(() => {
			const levels: string[] = app.ready?.thinkingLevels ?? ["off", "low", "medium", "high", "max"];
			const at = Math.max(0, levels.indexOf(level));
			const strength = levels.length > 1 ? at / (levels.length - 1) : 1;
			const calm = at < levels.indexOf(from.level);
			app.eyes.touch();
			eyes?.perk(strength, calm);
			dots?.burst(calm ? "calm" : "level", { tone: app.tint, strength });
		});
	});

	function onkeydown(event: KeyboardEvent) {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			if (app.needsConnect) return;
			if (dictating) return;
			const value = text;
			text = "";
			void app.submit(value);
		}
	}
</script>

<div
	class="head"
	class:open
	class:right={app.layout.alignRight}
	class:above={app.layout.above}
	class:tall={height > d.pillH}
	class:travelling={app.travelling !== null}
	class:arrived={app.arrived}
	style:--lean-x="{lean.x}px"
	style:--lean-y="{lean.y}px"
	style:width="{open ? width : d.pillW}px"
	style:height="{height}px"
	style:--font="{d.font}px"
	style:--pill-w="{d.pillW}px"
	style:--pill-h="{d.pillH}px"
	style:--radius="{d.pillH / 2}px"
	style:--body-w="{width - d.pillW}px"
	style:--eye="{d.eye}px"
>
	<Dots
		bind:this={dots}
		width={open ? width : d.pillW}
		{height}
		pillW={d.pillW}
		pillH={d.pillH}
		alignRight={app.layout.alignRight}
		above={app.layout.above}
		expression={app.eyes.state}
		colour={lookFor(app.eyes.state, app.tint).colour}
		animate={app.eyes.animate}
		reduceMotion={app.eyes.reduceMotion}
		level={app.talkLevel}
	/>
	<button
		class="eyes"
		type="button"
		aria-label={open ? "Close Winku" : "Open Winku"}
		{onpointerdown}
		onmousedown={(event) => event.preventDefault()}
		{onpointermove}
		{onpointerup}
		{oncontextmenu}
		onclick={(event) => {
			if (event.detail === 0) void (open ? app.hide() : app.summon());
		}}
	>
		<Eyes
			bind:this={eyes}
			expression={app.eyes.state}
			tint={app.tint}
			lid={app.lid}
			progress={app.download?.fraction ?? null}
			eyeSize={d.eye}
			spacing={d.spacing}
			animate={app.eyes.animate}
			reduceMotion={app.eyes.reduceMotion}
		/>
		{#if (app.updateReady || waiting > 0) && !open}
			<span class="badges">
				{#if app.updateReady}
					<span class="dot update" title="Winku {app.updateReady} installs when you quit or restart"></span>
				{/if}
				{#if waiting > 0}
					<span class="dot tasks" style:background={app.tint} title="{waiting} scheduled {waiting === 1 ? 'task' : 'tasks'}"></span>
				{/if}
			</span>
		{/if}
	</button>

	{#if open}
		<div class="body" in:fade={{ duration: ms(180), delay: ms(60), easing: cubicOut }} out:fade={{ duration: ms(110) }}>
			<div class="field" bind:clientHeight={app.inputH}>
				<textarea
					bind:this={input}
					value={shown}
					rows="1"
					placeholder={app.listening ? "Listening…" : app.needsConnect ? "Connect a model first" : "Ask anything"}
					disabled={app.needsConnect}
					readonly={dictating}
					class:dictating
					aria-label="Message"
					{onkeydown}
					oninput={(event) => {
						if (!dictating) text = event.currentTarget.value;
					}}
				></textarea>
			</div>

			{#if !app.needsConnect && !app.crowded}
				<div class="meta" bind:this={meta} in:fade={{ duration: ms(160), easing: cubicOut }}><Meta {app} /></div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.head {
		position: absolute;
		/* clip, not hidden: a hidden box can be scrolled, and focusing the message box while the
		   bar is still narrow would scroll it into view, sliding the eyes. */
		overflow: clip;
		/* No outline: the dark face and the eyes are the edge. */
		/* Half the pill's height, in px: a bar that grows taller keeps the same corners. */
		border-radius: var(--radius);
		background: radial-gradient(ellipse 72% 72% at 50% 28%, var(--face-hi), var(--face-lo));
		/* Closing eases in and finishes before the shell trims the window (App.svelte, 240 ms). */
		transition:
			width 190ms cubic-bezier(0.4, 0, 0.6, 1),
			height 120ms cubic-bezier(0.22, 1, 0.36, 1);
		contain: layout paint;
	}
	.head.open {
		transition:
			width 260ms cubic-bezier(0.22, 1, 0.36, 1),
			height 120ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	/* The eyes sit in the anchored corner, in a box the size of the pill: left on the left half of
	   the screen, right on the right half, and at the bottom when the bar grows upward. */
	.eyes {
		position: absolute;
		top: 0;
		left: 0;
		z-index: 1;
		display: grid;
		place-items: center;
		width: var(--pill-w);
		height: var(--pill-h);
		padding: 0;
		border: 0;
		border-radius: 999px;
		background: none;
		cursor: pointer;
		user-select: none;
		touch-action: none;
	}
	.right .eyes {
		left: auto;
		right: 0;
	}
	.above .eyes {
		top: auto;
		bottom: 0;
	}
	.eyes:focus-visible {
		outline-offset: -3px;
	}
	/* A press squeezes the eyes a little; letting go springs back. */
	.eyes :global(.glancer) {
		transition:
			scale 260ms cubic-bezier(0.3, 1.6, 0.5, 1),
			translate 260ms cubic-bezier(0.3, 1.6, 0.5, 1);
	}
	.eyes:active :global(.glancer) {
		scale: 0.9;
		transition-duration: 80ms;
	}
	/* On the way to the pointer the eyes lean into the trip and stretch a touch; arriving, they
	   settle with a wobble. All inside the pill, so the window's outline never clips it. */
	.travelling .eyes :global(.glancer) {
		scale: 1.08 0.92;
		translate: var(--lean-x, 0) var(--lean-y, 0);
		transition:
			scale 160ms ease-out,
			translate 160ms ease-out;
	}
	.arrived .eyes :global(.glancer) {
		animation: settle 620ms cubic-bezier(0.3, 0.6, 0.4, 1);
	}
	@keyframes settle {
		0% {
			scale: 1.14 0.84;
		}
		35% {
			scale: 0.93 1.1;
		}
		65% {
			scale: 1.04 0.97;
		}
		100% {
			scale: 1;
		}
	}
	/* Status under the eyes, centred between them and the pill's lower edge: a dot in the accent
	   when an update is waiting (SPEC §1), one in the resting tint while something is scheduled
	   (#43). Static: no pulse. */
	.badges {
		position: absolute;
		left: 0;
		right: 0;
		top: calc((var(--pill-h) + var(--eye)) / 2 + (var(--pill-h) - var(--eye)) / 4);
		translate: 0 -50%;
		display: flex;
		justify-content: center;
		gap: 4px;
		pointer-events: none;
	}
	.dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
	}
	.dot.update {
		background: var(--accent);
	}
	/* Fixed at the open width, beside the eyes, so it is uncovered rather than squeezed. */
	.body {
		position: absolute;
		top: 0;
		bottom: 0;
		left: var(--pill-w);
		width: var(--body-w);
		display: flex;
		align-items: center;
		transition: width 260ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.right .body {
		left: auto;
		right: var(--pill-w);
	}
	.field {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 7px;
	}
	.head:not(.right) .field {
		padding-right: 12px;
	}
	.head.right .field {
		padding-left: 20px;
		padding-right: 12px;
	}
	textarea {
		display: block;
		width: 100%;
		resize: none;
		border: 0;
		outline: none;
		background: none;
		font-size: var(--font);
		line-height: 1.45;
		padding: 0;
		overflow-y: hidden;
		transition: color 160ms;
	}
	/* Past INPUT_LINES the box scrolls, with the bar's thin thumb. */
	textarea:global(.scrolls) {
		overflow-y: auto;
		padding-right: 6px;
	}
	textarea::-webkit-scrollbar {
		width: 4px;
	}
	textarea::-webkit-scrollbar-thumb {
		border: 0;
		background: rgb(255 255 255 / 0.2);
	}
	textarea::placeholder {
		color: var(--muted);
		/* One line, cut short: the meta row can leave the box narrow (update, waiting tasks). */
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* Words still being heard can change, so they sit back a little until they are sent. */
	textarea.dictating {
		color: var(--muted);
		cursor: default;
	}
	/* The bar is the input: the caret shows focus, a ring around the text would box it in. */
	textarea:focus-visible {
		outline: none;
	}
	.meta {
		flex: none;
		align-self: flex-start;
		height: var(--pill-h);
		display: flex;
		align-items: center;
	}
	.above .meta {
		align-self: flex-end;
	}
	.head:not(.right) .meta {
		padding-right: 14px;
	}
	.head.right .meta {
		padding-right: 2px;
	}
</style>
