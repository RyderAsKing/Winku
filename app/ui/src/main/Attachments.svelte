<script lang="ts">
	// What goes with the next message, as pills of their own just off the bar, on the bubble's
	// side: a thumbnail of the screenshot, and the start of the selection in quotes. Hovering the
	// selection unrolls it into a card with all of it. The screenshot is one button that takes it
	// off; the selection comes off with its cross, so reading it never drops it.
	import type { MainState } from "./state.svelte.ts";

	let {
		app,
		peek = $bindable(0),
	}: {
		app: MainState;
		/** How far the open card reaches from the bar side of the bubbles, so the window keeps it. */
		peek?: number;
	} = $props();

	const PAD_X = 14 + 30; // the text's left padding and the cross's lane
	const PAD_Y = 7 + 8;
	const OPEN_W = 320;
	const OPEN_MAX_H = 7 * 18 + PAD_Y; // seven lines, then it scrolls
	const DELAY = 150; // hover intent, so sweeping across the row doesn't flash it
	const CLOSE = 280; // the card's close, a beat and then 220 ms

	const quote = $derived(app.selectionChip?.trim() ?? "");

	let slot = $state<HTMLElement>();
	let measure = $state<HTMLElement>();
	let open = $state(false);
	let openW = $state(0);
	let openH = $state(0);
	/** A long selection scrolls in the card, once it has finished opening. */
	let scrolls = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	function show() {
		clearTimeout(timer);
		timer = setTimeout(() => {
			if (!slot || !measure) return;
			const box = slot.closest(".bubbles")?.getBoundingClientRect();
			const at = slot.getBoundingClientRect();
			openW = Math.max(at.width, Math.min(OPEN_W, (box?.right ?? at.right) - at.left));
			measure.style.width = `${openW - PAD_X}px`;
			const full = Math.ceil(measure.offsetHeight) + PAD_Y;
			openH = Math.min(OPEN_MAX_H, full);
			// Only grow when the pill cuts the selection short.
			if (!overflows()) return;
			open = true;
			timer = setTimeout(() => (scrolls = full > OPEN_MAX_H), CLOSE);
			const above = app.layout.above;
			peek = box ? Math.ceil(above ? box.bottom - at.bottom + openH : at.top - box.top + openH) : openH;
		}, DELAY);
	}
	function hide() {
		clearTimeout(timer);
		if (!open) return;
		open = scrolls = false;
		timer = setTimeout(() => (peek = 0), CLOSE);
	}
	/** Whether the one-line text is cut short. */
	function overflows() {
		const text = slot?.querySelector<HTMLElement>(".line");
		return !!text && text.scrollWidth > text.clientWidth;
	}
	$effect(() => {
		// A new selection, or none: start from the pill.
		void quote;
		return () => {
			clearTimeout(timer);
			open = scrolls = false;
			peek = 0;
		};
	});
</script>

<div class="attachments">
	{#if app.imageChip}
		<!-- With the selection beside it, the thumbnail alone says what it is. -->
		<button type="button" class="chip shot" aria-label="Remove screenshot" title="Screenshot attached. Click to remove." onclick={() => (app.imageChip = null)}>
			<img src="data:{app.imageChip.mimeType};base64,{app.imageChip.data}" alt="" />
			{#if !app.selectionChip}<span class="name">Screenshot</span>{/if}
			<span class="x" aria-hidden="true"></span>
		</button>
	{/if}
	{#if app.selectionChip}
		<div class="slot" bind:this={slot}>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="chip quote"
				class:open
				class:scrolls
				style:width={open ? `${openW}px` : null}
				style:height={open ? `${openH}px` : null}
				onpointerenter={show}
				onpointerleave={hide}
				onfocusin={show}
				onfocusout={hide}
			>
				<!-- The first words on one line and all of it, wrapped, cross-fade as the card opens
				     and closes, so neither shows cut off while the card is between sizes. -->
				<p class="text line">{quote}</p>
				<p class="text full" aria-hidden="true" style:width="{openW - PAD_X}px">{quote}</p>
				<button type="button" class="x" aria-label="Remove selection" onclick={() => (app.selectionChip = null)}></button>
			</div>
			<p class="text measure" aria-hidden="true" bind:this={measure}>{quote}</p>
		</div>
	{/if}
</div>

<style>
	.attachments {
		display: flex;
		gap: 6px;
	}
	/* 32 px tall, rounded by half that, inside the bubble's corner (BUBBLE_RADIUS), so the
	   window's rounded outline never trims a chip. */
	.chip {
		position: relative;
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		height: 32px;
		max-width: 100%;
		padding: 0 30px 0 14px;
		border: 0;
		border-radius: 16px;
		background: radial-gradient(ellipse 72% 90% at 50% 20%, var(--face-hi), var(--face-lo));
		color: var(--text);
		font-size: 12px;
		cursor: pointer;
		animation: attach 240ms cubic-bezier(0.3, 1.5, 0.5, 1);
		transition: box-shadow 140ms ease;
	}
	/* Hovered: the pill lights up (a soft inner wash; it stays in place, inside the window's
	   outline), the text comes forward and the cross gets a backing, so it reads as "click to
	   take this off". */
	.chip:not(:disabled):hover {
		filter: none;
		box-shadow: inset 0 0 0 999px rgb(255 255 255 / 0.07);
	}
	.chip:hover .name {
		color: var(--text);
	}
	@keyframes attach {
		from {
			scale: 0.8;
			opacity: 0;
		}
	}
	.shot {
		padding-left: 4px;
	}
	.shot img {
		display: block;
		width: 38px;
		height: 24px;
		border-radius: 12px;
		object-fit: cover;
		object-position: top left;
	}
	.name {
		color: var(--muted);
	}
	/* The selection holds its place in the row: it has no width of its own and grows into the
	   room there is, so a long selection never pushes the row wider. The pill itself sits on top
	   of the slot so it can grow out of it. */
	.slot {
		position: relative;
		flex: 1 1 auto;
		min-width: 120px;
		max-width: 240px;
		height: 32px;
	}
	/* Hovered, the pill unrolls into a card with all of the selection: it widens and grows away
	   from the bar from the corner it sits in, the first line staying put, and rolls back up when
	   the pointer leaves. */
	.quote {
		position: absolute;
		top: 0;
		left: 0;
		z-index: 1;
		display: block;
		width: 100%;
		max-width: none;
		height: 32px;
		padding: 7px 30px 8px 14px;
		overflow: hidden;
		cursor: default;
		animation: none;
		/* Closing waits a beat for the full text to fade, so the cross never sits on it. */
		transition:
			width 220ms cubic-bezier(0.22, 1, 0.36, 1) 60ms,
			height 220ms cubic-bezier(0.22, 1, 0.36, 1) 60ms,
			border-radius 220ms ease 60ms,
			box-shadow 140ms ease;
	}
	:global(.above) .quote {
		top: auto;
		bottom: 0;
	}
	.quote.open {
		z-index: 2;
		transition:
			width 220ms cubic-bezier(0.22, 1, 0.36, 1),
			height 220ms cubic-bezier(0.22, 1, 0.36, 1),
			border-radius 220ms ease,
			box-shadow 140ms ease;
		border-radius: 14px;
	}
	.quote.scrolls {
		overflow-y: auto;
	}
	.slot {
		animation: attach 240ms cubic-bezier(0.3, 1.5, 0.5, 1);
	}
	.text {
		margin: 0;
		width: 100%;
		min-width: 0;
		color: var(--muted);
		font-size: 12px;
		line-height: 18px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		overflow-wrap: anywhere;
		transition: color 140ms ease;
	}
	.quote:hover .text {
		color: var(--text);
	}
	.line {
		position: absolute;
		top: 7px;
		left: 14px;
		width: auto;
		right: 30px;
		transition:
			opacity 160ms ease 60ms,
			color 140ms ease;
	}
	.full {
		opacity: 0;
		transition: opacity 80ms ease;
	}
	.open .line {
		opacity: 0;
		transition: opacity 100ms ease;
	}
	.open .full {
		opacity: 1;
		transition: opacity 180ms ease 20ms;
	}
	.full,
	.measure {
		white-space: pre-line;
		text-wrap-style: pretty;
		overflow: visible;
	}
	/* Sized like the open card's text, out of sight, to tell how tall the card needs to be. */
	.measure {
		position: absolute;
		top: 0;
		left: 0;
		visibility: hidden;
		pointer-events: none;
	}
	.text::before {
		content: "\201C";
	}
	.text::after {
		content: "\201D";
	}
	/* The remove mark: a small cross drawn with two strokes, level with the first line. */
	.x {
		position: absolute;
		top: 7px;
		right: 7px;
		width: 18px;
		height: 18px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: transparent;
		opacity: 0.55;
		cursor: pointer;
		transition:
			opacity 140ms ease,
			background-color 140ms ease;
	}
	.shot .x {
		top: 50%;
		translate: 0 -50%;
	}
	.chip:hover .x {
		opacity: 1;
	}
	.shot:hover .x,
	.quote .x:hover {
		background: rgb(255 255 255 / 0.12);
	}
	.x:not(:disabled):hover {
		filter: none;
	}
	.x::before,
	.x::after {
		content: "";
		position: absolute;
		top: 8.5px;
		left: 5px;
		width: 8px;
		height: 1px;
		background: var(--text);
		rotate: 45deg;
	}
	.x::after {
		rotate: -45deg;
	}
</style>
