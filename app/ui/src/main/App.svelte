<script lang="ts">
	// The main window: a fixed stage with the pill in one corner (see stage.ts). The pill opens
	// into the bar in place, and replies show in a bubble under it, or over it low on the screen.
	import { cubicIn } from "svelte/easing";
	import { fly } from "svelte/transition";
	import { ms, pop } from "../lib/motion.ts";
	import "../lib/theme.css";
	import Attachments from "./Attachments.svelte";
	import Connect from "./Connect.svelte";
	import Head from "./Head.svelte";
	import Meta from "./Meta.svelte";
	import HotkeyHints from "./HotkeyHints.svelte";
	import ReplyBubble from "./ReplyBubble.svelte";
	import { barWidth, GAP, headHeight, STRIP, stageSize, wideReasons } from "./stage.ts";
	import { MainState } from "./state.svelte.ts";
	import TranscriptList from "./TranscriptList.svelte";
	import Visual from "./Visual.svelte";
	import { winkuKey } from "./visuals.ts";

	const app = new MainState();
	void app.init();

	// Outside Tauri the page shows the stage on a stand-in desktop.
	const framed = !("__TAURI_INTERNALS__" in window);

	const d = $derived(app.dims);
	const stage = $derived(stageSize(d));
	const open = $derived(app.mode !== "pill");
	const transcript = $derived(app.mode === "transcript");
	/** A visual opened larger, in the transcript-height bubble. */
	const large = $derived(open && app.largeVisual !== null);
	// While talking over the resting pill the bar is drawn open, though the window stays a pill.
	const barOpen = $derived(open || app.peek);
	// A long message makes the bar taller; the bubble gives up that much room.
	const headH = $derived(barOpen ? Math.min(headHeight(d, app.inputH), stage.h - STRIP - GAP - 120) : d.pillH);
	const bubbleMax = $derived(d.bubbleMax - (headH - d.pillH));
	const showReply = $derived(app.reply !== null && (open || app.bubbleOpen));
	const showHints = $derived(app.hotkeyHints && app.settings !== null);
	// Attachments float as pills of their own on the bubble's side of the bar. Once the message
	// reaches them the meter and thinking level float off the bar too, to give it the whole bar: into
	// the strip on the pill's far side, or, with the pill against that screen edge, as one pill
	// beside the attachments.
	const attached = $derived(app.selectionChip !== null || app.imageChip !== null);
	const floatMeta = $derived(barOpen && !app.needsConnect && app.crowded);
	const inStrip = $derived(floatMeta && (app.layout.room ?? true));
	const metaInRow = $derived(floatMeta && !inStrip);
	const showChips = $derived(barOpen && !app.needsConnect && (attached || metaInRow));
	let stripW = $state(0);
	/** The chips' rows (they wrap when crowded). */
	let chipsH = $state(0);
	const showBubble = $derived((open && (app.needsConnect || transcript || large)) || showReply || app.toast !== null || showChips);
	const above = $derived(app.layout.above);
	// Scrolled back through the conversation over the reply bubble: the bar and bubble widen to
	// read it, and narrow again back at the end.
	let browsing = $state(false);
	$effect(() => {
		if (!showReply || transcript) browsing = false;
	});
	// A bubble holding a visual is Wide too, until it closes; so is a visual opened larger, and the transcript while it holds one.
	const barW = $derived(
		barWidth(
			d,
			wideReasons({
				browsing: browsing && showReply && !transcript,
				visual: (showReply && !transcript && app.holdsVisual) || large,
				transcriptVisual: transcript && (app.holdsVisual || app.transcript.some((item) => item.kind === "visual")),
			}),
		),
	);

	// Loops (pulse, bounce) run while anything is showing or happening, not on the idle pill.
	$effect(() => {
		app.eyes.setBarVisible(barOpen || app.bubbleOpen || app.listening || app.busy || app.speaking);
	});

	// Tell the shell what is drawn. Growth is reported at once so nothing is clipped; shrinking
	// waits for the close animation so it isn't cut off. The shell trims the window a frame or two
	// after a report, so a growing bubble (a streamed reply adds a line at a time) is reported with
	// room to spare, in steps; otherwise each new line would show cut off for a frame.
	const STEP = 48;
	const roomy = (h: number) => Math.ceil((h + STEP / 2) / STEP) * STEP;
	let bubbleH = $state(0);
	// The hints draw over the bubble, so the window only has to be as tall as the taller of the two.
	let hintH = $state(0);
	// A hovered selection unrolls over the reply, and past it when the reply is short or gone.
	let peekH = $state(0);
	type Drawn = { headW: number; headH: number; bubbleH: number; bubbleW: number; stripW: number; key: string };
	let sent: Drawn | null = null;
	let shrinkTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		const next: Drawn = {
			headW: barOpen ? barW : d.pillW,
			headH,
			bubbleH: Math.max(showBubble ? roomy(bubbleH) : 0, showHints ? Math.ceil(hintH) : 0, showBubble && peekH ? roomy(peekH) : 0),
			// The hints are as wide as the bar at most.
			bubbleW: showBubble ? barW : d.barW,
			stripW: inStrip ? Math.ceil(stripW) : 0,
			key: `${app.settings?.eyes.size}:${app.layout.alignRight}:${app.layout.above}`,
		};
		const dims = d;
		clearTimeout(shrinkTimer);
		const send = (drawn: Drawn, headRoom = drawn.headH) => {
			sent = { ...drawn, headH: headRoom };
			void app.reportShape(dims, { ...drawn, headRoom });
		};
		if (sent && sent.headW === next.headW && sent.headH === next.headH && sent.bubbleH === next.bubbleH && sent.bubbleW === next.bubbleW && sent.stripW === next.stripW && sent.key === next.key) return;
		const same = sent !== null && sent.key === next.key;
		// The strip's pills leave at once, so there is nothing to wait for there.
		const shrinking = same && sent !== null && (next.headW < sent.headW || next.bubbleH < sent.bubbleH || next.bubbleW < sent.bubbleW);
		const shorter = same && sent !== null && next.headH < sent.headH;
		// Narrowing after scrolling back takes 260 ms; closing the bar, less.
		if (shrinking) shrinkTimer = setTimeout(() => send(next), next.bubbleW < (sent?.bubbleW ?? 0) || next.headW < (sent?.headW ?? 0) ? 280 : 240);
		else if (shorter && sent) {
			// The bar is getting shorter and the bubble moves up with it at once: give the bubble
			// its new place now, and keep the bar's old outline until it has finished shrinking.
			send(next, sent.headH);
			shrinkTimer = setTimeout(() => send(next), 240);
		} else send(next);
	});

	function onkeydown(event: KeyboardEvent) {
		const press = { key: event.key, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey };
		if (winkuKey(press)) {
			event.preventDefault();
			void app.key(press);
		}
	}

	// Focus moving into a visual's frame blurs the window too; only a click outside Winku counts.
	function onblur() {
		setTimeout(() => {
			if (!document.hasFocus()) void app.focusLost();
		}, 0);
	}

	// A click on the bubble under the resting pill opens the bar, unless it hit a control.
	function onBubbleClick(event: MouseEvent) {
		if (open) return;
		if ((event.target as HTMLElement).closest("button, a, summary, details, input, textarea, select")) return;
		void app.summon();
	}
</script>

<svelte:window {onkeydown} {onblur} />

<div class="root" class:framed>
	<div
		class="stage"
		class:right={app.layout.alignRight}
		class:above
		style:width="{stage.w}px"
		style:height="{stage.h}px"
		style:--strip="{STRIP}px"
		style:--gap="{STRIP + headH + GAP}px"
		style:--bubble-max="{bubbleMax}px"
		style:--bar-w="{d.barW}px"
	>
		<Head {app} open={barOpen} height={headH} width={barW} />

		{#if inStrip}
			<div class="strip" bind:offsetWidth={stripW}><Meta {app} look="pills" /></div>
		{/if}

		{#if showBubble}
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
			<div
				class="bubbles"
				style:width="{barW}px"
				bind:offsetHeight={bubbleH}
				onclick={onBubbleClick}
				onpointerenter={() => app.holdBubble(true)}
				onpointerleave={() => app.holdBubble(false)}
				in:pop={{ y: above ? 10 : -10, duration: 280, delay: open ? 40 : 0 }}
				out:fly={{ y: above ? 4 : -4, duration: ms(140), easing: cubicIn }}
			>
				{#if showChips}
					<div class="chips" bind:offsetHeight={chipsH}>
						{#if attached}<Attachments {app} bind:peek={peekH} />{/if}
						{#if metaInRow}<div class="float-meta"><Meta {app} look="merged" /></div>{/if}
					</div>
				{/if}
				{#if open && app.needsConnect}
					<div class="bubble pad scroll"><Connect {app} /></div>
				{:else if large && app.largeVisual}
					<div class="bubble transcript large-visual"><Visual {app} visual={app.largeVisual} large /></div>
				{:else if transcript}
					<div class="bubble transcript"><TranscriptList {app} items={app.transcript} /></div>
				{:else if showReply && app.reply}
					<div class="bubble reply-box" class:resting={!open}><ReplyBubble {app} reply={app.reply} max={bubbleMax - (showChips ? chipsH + 6 : 0)} bind:browsing /></div>
				{/if}
				{#if app.toast}
					<div class="bubble toast" role="status" in:pop={{ y: above ? 6 : -6, duration: 240 }}>
						<span>{app.toast.text}</span>
						{#if app.toast.action}
							<button type="button" onclick={app.toast.action.run}>{app.toast.action.label}</button>
						{/if}
					</div>
				{/if}
			</div>
		{/if}

		<!-- Over the bubble, not in its column: the chat keeps its size while the hints show. -->
		{#if showHints && app.settings}
			<div
				class="bubble hint-bubble"
				bind:offsetHeight={hintH}
				in:pop={{ y: above ? 6 : -6, duration: 200, from: 0.94 }}
				out:fly={{ duration: ms(90), opacity: 0 }}
			>
				<HotkeyHints settings={app.settings} />
			</div>
		{/if}
	</div>
</div>

<style>
	:global(html),
	:global(body) {
		background: transparent;
		overflow: hidden;
	}
	.root {
		width: 100%;
		height: 100%;
	}
	/* The stage is pinned to the window corner the pill is in, so a window that is only as big as
	   the pill (outside Windows) still shows the pill. */
	.stage {
		position: fixed;
		top: 0;
		left: 0;
	}
	.stage.right {
		left: auto;
		right: 0;
	}
	.stage.above {
		top: auto;
		bottom: 0;
	}
	/* The pill sits the strip's height in from the stage's edge: the strip is on its far side. */
	.stage :global(.head) {
		top: var(--strip);
		left: 0;
	}
	.stage.right :global(.head) {
		left: auto;
		right: 0;
	}
	.stage.above :global(.head) {
		top: auto;
		bottom: var(--strip);
	}
	/* The meter and thinking level while you type, over the bar's eyes end (under it, low on the
	   screen). */
	.strip {
		position: absolute;
		top: 0;
		left: 0;
	}
	.right .strip {
		left: auto;
		right: 0;
	}
	.above .strip {
		top: auto;
		bottom: 0;
	}
	.bubbles {
		position: absolute;
		top: var(--gap);
		left: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
		max-height: var(--bubble-max);
		/* Bubbles grow out of the corner the eyes are in. */
		transform-origin: 0 0;
		transition: width 260ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.right .bubbles {
		left: auto;
		right: 0;
		transform-origin: 100% 0;
	}
	.above .bubbles {
		top: auto;
		bottom: var(--gap);
		flex-direction: column-reverse;
		transform-origin: 0 100%;
	}
	.right.above .bubbles {
		transform-origin: 100% 100%;
	}
	/* Attachments at the start; with no strip, the meter and thinking level at the end. The
	   selection shrinks first (to its minimum); only past that does the meter wrap. */
	.chips {
		position: relative;
		z-index: 2;
		flex: none;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.chips > :global(.attachments) {
		flex: 1 1 0;
		min-width: auto;
		max-width: 100%;
	}
	.float-meta {
		flex: none;
		margin-left: auto;
	}
	/* Translucent and rounded, apart from the pill: the reply sits over whatever is behind. No
	   outline, like the pill. */
	.bubble {
		min-height: 0;
		border-radius: 18px; /* BUBBLE_RADIUS in stage.ts */
		background: rgb(14 16 21 / 0.88);
		overflow-wrap: anywhere;
	}
	.pad {
		padding: 12px 16px 14px;
	}
	.scroll {
		flex: 0 1 auto;
		overflow-y: auto;
	}
	.reply-box {
		flex: none;
		overflow: hidden;
	}
	.resting {
		cursor: pointer;
	}
	.large-visual {
		overflow-y: auto;
		padding: 8px 14px;
	}
	.transcript {
		height: var(--bubble-max);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	/* The hints hug the eyes' side rather than spanning the bar, and sit on top of whatever the
	   bubble shows. Opaque, so the chat underneath doesn't read through the keys. */
	.hint-bubble {
		position: absolute;
		z-index: 2;
		top: var(--gap);
		left: 0;
		max-width: var(--bar-w);
		max-height: var(--bubble-max);
		overflow: hidden;
		background: rgb(14 16 21);
		transform-origin: 0 0;
	}
	.right .hint-bubble {
		left: auto;
		right: 0;
		transform-origin: 100% 0;
	}
	.above .hint-bubble {
		top: auto;
		bottom: var(--gap);
		transform-origin: 0 100%;
	}
	.right.above .hint-bubble {
		transform-origin: 100% 100%;
	}
	.toast {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 10px 8px 16px;
		color: var(--muted);
		font-size: 13px;
	}
	.toast button {
		flex: none;
		min-height: 28px;
		border: 0;
		background: none;
		color: var(--accent);
		cursor: pointer;
		font-weight: 600;
	}

	/* The browser preview: a stand-in desktop with the stage outlined faintly. */
	.framed {
		position: relative;
		background:
			radial-gradient(circle at 20% 15%, #2d4057 0, transparent 45%),
			radial-gradient(circle at 80% 70%, #4b3a52 0, transparent 50%),
			#1b2230;
	}
	.framed .stage {
		position: absolute;
		top: 64px;
		left: 64px;
	}
	.framed .stage.right {
		left: auto;
		right: 64px;
	}
	.framed .stage.above {
		top: auto;
		bottom: 64px;
	}
</style>
