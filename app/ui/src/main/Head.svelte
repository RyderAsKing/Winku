<script lang="ts">
	// The pill, and the bar it stretches into. The eyes never move: the bar grows from the pill
	// toward the middle of the screen. Click the eyes to open or close, drag them to move Winku,
	// right-click for the menu. Open: the message box, then the context meter and thinking level.
	//
	// The eyes are pinned to the anchored corner and the body is laid out at the full bar width the
	// whole time, so opening and closing only move the clip edge: nothing inside reflows or slides.
	// A long message makes the bar taller, away from the eyes' row, up to INPUT_LINES; then the
	// message box scrolls.
	import { cubicOut } from "svelte/easing";
	import { fade } from "svelte/transition";
	import { ms } from "../lib/motion.ts";
	import Eyes from "../lib/eyes/Eyes.svelte";
	import { shell } from "../lib/shell.ts";
	import { INPUT_LINES } from "./stage.ts";
	import type { MainState } from "./state.svelte.ts";

	/** `open`: the bar is showing. `height`: the bar's height, taller than the pill for a long message. */
	let { app, open, height }: { app: MainState; open: boolean; height: number } = $props();

	let eyes: Eyes | undefined = $state();
	let input: HTMLTextAreaElement | undefined = $state();
	let text = $state("");

	$effect(() => app.eyes.attach(eyes));

	// Due scheduled tasks wait while there is a draft (#43).
	$effect(() => app.setDraft(text.trim().length > 0));

	$effect(() => {
		void app.focusTick;
		input?.focus({ preventScroll: true });
	});

	const d = $derived(app.dims);
	const ctx = $derived(app.contextPercent === null ? null : Math.round(app.contextPercent));
	const waiting = $derived(app.tasks.length);
	const selectionWords = $derived(app.selectionChip ? app.selectionChip.trim().split(/\s+/).length : 0);
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
		autosize();
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
	style:width="{open ? d.barW : d.pillW}px"
	style:height="{height}px"
	style:--font="{d.font}px"
	style:--pill-w="{d.pillW}px"
	style:--pill-h="{d.pillH}px"
	style:--radius="{d.pillH / 2}px"
	style:--body-w="{d.barW - d.pillW}px"
>
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
		{#if app.updateReady && !open}
			<span class="dot" title="Winku {app.updateReady} installs when you quit or restart"></span>
		{/if}
		{#if waiting > 0 && !open}
			<span class="dot tasks" style:background={app.tint} title="{waiting} scheduled {waiting === 1 ? 'task' : 'tasks'}"></span>
		{/if}
	</button>

	{#if open}
		<div class="body" in:fade={{ duration: ms(180), delay: ms(60), easing: cubicOut }} out:fade={{ duration: ms(110) }}>
			<div class="field" bind:clientHeight={app.inputH}>
				{#if app.selectionChip || app.imageChip}
					<div class="attached">
						{#if app.imageChip}
							<button type="button" class="shot" aria-label="Remove screenshot" title="Screenshot attached. Click to remove." onclick={() => (app.imageChip = null)}>
								<img src="data:{app.imageChip.mimeType};base64,{app.imageChip.data}" alt="" />
								<span class="x" aria-hidden="true"></span>
							</button>
						{/if}
						{#if app.selectionChip}
							<button type="button" class="quote" aria-label="Remove selection" title="Selected text attached. Click to remove." onclick={() => (app.selectionChip = null)}>
								<span class="quote-text">{app.selectionChip.trim()}</span>
								<span class="quote-count">{selectionWords} {selectionWords === 1 ? "word" : "words"}</span>
								<span class="x" aria-hidden="true"></span>
							</button>
						{/if}
					</div>
				{/if}
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

			{#if !app.needsConnect}
				<div class="meta">
					{#if app.updateReady}
						<button type="button" class="mono level" title="Install Winku {app.updateReady} and restart" onclick={() => shell.updateRestart()}>Restart to update</button>
					{/if}
					{#if app.download}
						<span class="mono" title="Downloading a voice model">{app.download.what === "stt" ? "Speech" : "Voice"} model {Math.round(app.download.fraction * 100)}%</span>
					{/if}
					{#if waiting > 0}
						<button type="button" class="mono level" title="Scheduled tasks" onclick={() => app.openSchedules()}>{waiting} waiting</button>
					{/if}
					{#if ctx !== null}<span class="mono" title="Context used">{ctx}% ctx</span>{/if}
					<button type="button" class="mono level" title="Thinking level (Ctrl+Alt+T)" onclick={() => app.cycleThinking()}>
						{app.thinking}
					</button>
				</div>
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
		border: 1px solid var(--line);
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
		/* The pill's inner box, so the eyes are centred inside the border. */
		width: calc(var(--pill-w) - 2px);
		height: calc(var(--pill-h) - 2px);
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
	/* An update is waiting (SPEC §1). Static: no pulse. */
	.dot {
		position: absolute;
		top: 18%;
		right: 22%;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
	}
	/* Something is scheduled (#43): opposite the update dot, in the resting tint. Static. */
	.dot.tasks {
		top: auto;
		right: auto;
		bottom: 18%;
		left: 22%;
	}
	/* Fixed at the open width, beside the eyes, so it is uncovered rather than squeezed. */
	.body {
		position: absolute;
		top: 0;
		bottom: 0;
		left: calc(var(--pill-w) - 2px);
		width: var(--body-w);
		display: flex;
		align-items: center;
	}
	.right .body {
		left: auto;
		right: calc(var(--pill-w) - 2px);
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
	/* What goes with the message: a thumbnail of the screenshot, the start of the selection.
	   Each is one button; clicking it takes the attachment off. */
	.attached {
		display: flex;
		gap: 6px;
		min-width: 0;
	}
	.shot,
	.quote {
		position: relative;
		flex: none;
		height: 38px;
		padding: 0;
		border: 1px solid var(--line-strong);
		border-radius: 10px;
		background: var(--panel-raised);
		cursor: pointer;
		overflow: hidden;
		animation: attach 240ms cubic-bezier(0.3, 1.5, 0.5, 1);
	}
	@keyframes attach {
		from {
			scale: 0.8;
			opacity: 0;
		}
	}
	.shot {
		width: 56px;
	}
	.shot img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
		object-position: top left;
	}
	.quote {
		flex: 0 1 auto;
		min-width: 0;
		max-width: 190px;
		display: grid;
		align-content: center;
		gap: 1px;
		padding: 0 26px 0 10px;
		text-align: left;
		box-shadow: inset 2px 0 0 var(--accent);
	}
	.quote-text {
		font-size: 12px;
		line-height: 1.25;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.quote-count {
		font-size: 10px;
		line-height: 1.25;
		color: var(--faint);
	}
	/* The remove mark: a small cross in the corner, drawn with two strokes. */
	.x {
		position: absolute;
		top: 3px;
		right: 3px;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: rgb(7 8 12 / 0.78);
	}
	.x::before,
	.x::after {
		content: "";
		position: absolute;
		top: 6.5px;
		left: 3.5px;
		width: 7px;
		height: 1px;
		background: var(--text);
		rotate: 45deg;
	}
	.x::after {
		rotate: -45deg;
	}
	.quote .x {
		top: 50%;
		right: 6px;
		translate: 0 -50%;
		background: none;
	}
	.meta {
		flex: none;
		align-self: flex-start;
		height: calc(var(--pill-h) - 2px);
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--faint);
		font-size: 11px;
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
	.level {
		border: 1px solid var(--line);
		border-radius: 999px;
		background: none;
		color: var(--muted);
		padding: 3px 8px;
		cursor: pointer;
		font-size: 11px;
	}
</style>
