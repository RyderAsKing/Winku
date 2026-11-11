<script lang="ts">
	// The pill, and the bar it stretches into. The eyes never move: the bar grows from the pill
	// toward the middle of the screen. Click the eyes to open or close, drag them to move Winku,
	// right-click for the menu. Open: the message box, then the context meter and thinking level.
	//
	// The eyes are pinned to the anchored end and the body is laid out at the full bar width the
	// whole time, so opening and closing only move the clip edge: nothing inside reflows or slides.
	import { cubicOut } from "svelte/easing";
	import { fade } from "svelte/transition";
	import { ms } from "../lib/motion.ts";
	import Eyes from "../lib/eyes/Eyes.svelte";
	import { shell } from "../lib/shell.ts";
	import type { MainState } from "./state.svelte.ts";

	let { app, open }: { app: MainState; open: boolean } = $props();

	let eyes: Eyes | undefined = $state();
	let input: HTMLTextAreaElement | undefined = $state();
	let text = $state("");

	$effect(() => app.eyes.attach(eyes));

	$effect(() => {
		void app.focusTick;
		input?.focus({ preventScroll: true });
	});

	const d = $derived(app.dims);
	const ctx = $derived(app.contextPercent === null ? null : Math.round(app.contextPercent));
	const selectionWords = $derived(app.selectionChip ? app.selectionChip.trim().split(/\s+/).length : 0);

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
			void shell.startDrag();
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
		input.style.height = `${Math.min(input.scrollHeight, d.pillH - 16)}px`;
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			if (app.needsConnect) return;
			const value = text;
			text = "";
			queueMicrotask(autosize);
			void app.submit(value);
		}
	}
</script>

<div
	class="head"
	class:open
	class:right={app.layout.alignRight}
	style:width="{open ? d.barW : d.pillW}px"
	style:height="{d.pillH}px"
	style:--font="{d.font}px"
	style:--pill-w="{d.pillW}px"
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
	</button>

	{#if open}
		<div class="body" in:fade={{ duration: ms(180), delay: ms(60), easing: cubicOut }} out:fade={{ duration: ms(110) }}>
			<div class="field">
				{#if app.selectionChip || app.imageChip}
					<div class="chips">
						{#if app.selectionChip}
							<span class="chip">
								Selection, {selectionWords} {selectionWords === 1 ? "word" : "words"}
								<button type="button" aria-label="Remove selection" onclick={() => (app.selectionChip = null)}>×</button>
							</span>
						{/if}
						{#if app.imageChip}
							<span class="chip">
								Screenshot
								<button type="button" aria-label="Remove screenshot" onclick={() => (app.imageChip = null)}>×</button>
							</span>
						{/if}
					</div>
				{/if}
				<textarea
					bind:this={input}
					bind:value={text}
					rows="1"
					placeholder={app.listening ? "Listening…" : app.needsConnect ? "Connect a model first" : "Ask anything"}
					disabled={app.needsConnect}
					aria-label="Message"
					{onkeydown}
					oninput={autosize}
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
		border-radius: 999px;
		background: radial-gradient(ellipse 72% 72% at 50% 28%, var(--face-hi), var(--face-lo));
		/* Closing eases in and finishes before the shell trims the window (App.svelte, 240 ms). */
		transition: width 190ms cubic-bezier(0.4, 0, 0.6, 1);
		contain: layout paint;
	}
	.head.open {
		transition: width 260ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	/* The eyes sit at the anchored end: left on the left half, right on the right half. */
	.eyes {
		position: absolute;
		top: 0;
		left: 0;
		z-index: 1;
		display: grid;
		place-items: center;
		/* The pill's inner box, so the eyes are centred inside the border. */
		width: calc(var(--pill-w) - 2px);
		height: 100%;
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
	.eyes:focus-visible {
		outline-offset: -3px;
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
		gap: 3px;
	}
	.head:not(.right) .field {
		padding-right: 4px;
	}
	.head.right .field {
		padding-left: 20px;
	}
	textarea {
		width: 100%;
		resize: none;
		border: 0;
		outline: none;
		background: none;
		font-size: var(--font);
		line-height: 1.45;
		padding: 0;
	}
	textarea::placeholder {
		color: var(--muted);
	}
	/* The bar is the input: the caret shows focus, a ring around the text would box it in. */
	textarea:focus-visible {
		outline: none;
	}
	.chips {
		display: flex;
		gap: 6px;
		flex-wrap: nowrap;
		overflow: hidden;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		padding: 0 2px 0 8px;
		border-radius: 999px;
		background: var(--panel-raised);
		border: 1px solid var(--line-strong);
		font-size: 11px;
		color: var(--muted);
		white-space: nowrap;
	}
	.chip button {
		min-width: 20px;
		min-height: 20px;
		border: 0;
		background: none;
		color: var(--muted);
		cursor: pointer;
		padding: 0 4px;
		font-size: 13px;
		line-height: 1;
	}
	.meta {
		flex: none;
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--faint);
		font-size: 11px;
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
