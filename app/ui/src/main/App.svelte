<script lang="ts">
	// The main window: a fixed stage with the pill in one corner (see stage.ts). The pill opens
	// into the bar in place, and replies show in a bubble under it, or over it low on the screen.
	import { cubicIn } from "svelte/easing";
	import { fly } from "svelte/transition";
	import { ms, pop } from "../lib/motion.ts";
	import "../lib/theme.css";
	import Connect from "./Connect.svelte";
	import Head from "./Head.svelte";
	import HotkeyHints from "./HotkeyHints.svelte";
	import ReplyBubble from "./ReplyBubble.svelte";
	import { GAP, headHeight, stageSize } from "./stage.ts";
	import { MainState } from "./state.svelte.ts";
	import TranscriptList from "./TranscriptList.svelte";

	const app = new MainState();
	void app.init();

	// Outside Tauri the page shows the stage on a stand-in desktop.
	const framed = !("__TAURI_INTERNALS__" in window);

	const d = $derived(app.dims);
	const stage = $derived(stageSize(d));
	const open = $derived(app.mode !== "pill");
	const transcript = $derived(app.mode === "transcript");
	// While talking over the resting pill the bar is drawn open, though the window stays a pill.
	const wide = $derived(open || app.peek);
	// A long message makes the bar taller; the bubble gives up that much room.
	const headH = $derived(wide ? Math.min(headHeight(d, app.inputH), stage.h - GAP - 120) : d.pillH);
	const bubbleMax = $derived(d.bubbleMax - (headH - d.pillH));
	const showReply = $derived(app.reply !== null && (open || app.bubbleOpen));
	const showHints = $derived(app.hotkeyHints && app.settings !== null);
	const showBubble = $derived((open && (app.needsConnect || transcript)) || showReply || app.toast !== null);
	const above = $derived(app.layout.above);

	// Loops (pulse, bounce) run while anything is showing or happening, not on the idle pill.
	$effect(() => {
		app.eyes.setBarVisible(wide || app.bubbleOpen || app.listening || app.busy || app.speaking);
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
	type Drawn = { headW: number; headH: number; bubbleH: number; key: string };
	let sent: Drawn | null = null;
	let shrinkTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		const next: Drawn = {
			headW: wide ? d.barW : d.pillW,
			headH,
			bubbleH: Math.max(showBubble ? roomy(bubbleH) : 0, showHints ? Math.ceil(hintH) : 0),
			key: `${app.settings?.eyes.size}:${app.layout.alignRight}:${app.layout.above}`,
		};
		const dims = d;
		clearTimeout(shrinkTimer);
		const send = (drawn: Drawn, headRoom = drawn.headH) => {
			sent = { ...drawn, headH: headRoom };
			void app.reportShape(dims, drawn.headW, drawn.headH, drawn.bubbleH, headRoom);
		};
		if (sent && sent.headW === next.headW && sent.headH === next.headH && sent.bubbleH === next.bubbleH && sent.key === next.key) return;
		const same = sent !== null && sent.key === next.key;
		const shrinking = same && sent !== null && (next.headW < sent.headW || next.bubbleH < sent.bubbleH);
		const shorter = same && sent !== null && next.headH < sent.headH;
		if (shrinking) shrinkTimer = setTimeout(() => send(next), 240);
		else if (shorter && sent) {
			// The bar is getting shorter and the bubble moves up with it at once: give the bubble
			// its new place now, and keep the bar's old outline until it has finished shrinking.
			send(next, sent.headH);
			shrinkTimer = setTimeout(() => send(next), 240);
		} else send(next);
	});

	function onkeydown(event: KeyboardEvent) {
		if (event.key === "Escape") {
			event.preventDefault();
			void app.escape();
		} else if (event.key.toLowerCase() === "j" && event.ctrlKey && !event.altKey && !event.shiftKey) {
			event.preventDefault();
			void app.toggleTranscript();
		}
	}

	// A click on the bubble under the resting pill opens the bar, unless it hit a control.
	function onBubbleClick(event: MouseEvent) {
		if (open) return;
		if ((event.target as HTMLElement).closest("button, a, summary, details, input, textarea, select")) return;
		void app.summon();
	}
</script>

<svelte:window {onkeydown} />

<div class="root" class:framed>
	<div
		class="stage"
		class:right={app.layout.alignRight}
		class:above
		style:width="{stage.w}px"
		style:height="{stage.h}px"
		style:--gap="{headH + GAP}px"
		style:--bubble-max="{bubbleMax}px"
	>
		<Head {app} open={wide} height={headH} />

		{#if showBubble}
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
			<div
				class="bubbles"
				style:width="{d.barW}px"
				bind:offsetHeight={bubbleH}
				onclick={onBubbleClick}
				onpointerenter={() => app.holdBubble(true)}
				onpointerleave={() => app.holdBubble(false)}
				in:pop={{ y: above ? 10 : -10, duration: 280, delay: open ? 40 : 0 }}
				out:fly={{ y: above ? 4 : -4, duration: ms(140), easing: cubicIn }}
			>
				{#if open && app.needsConnect}
					<div class="bubble pad scroll"><Connect {app} /></div>
				{:else if transcript}
					<div class="bubble transcript"><TranscriptList {app} items={app.transcript} /></div>
				{:else if showReply && app.reply}
					<div class="bubble reply-box" class:resting={!open}><ReplyBubble {app} reply={app.reply} max={bubbleMax - 2} /></div>
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
	.stage :global(.head) {
		top: 0;
		left: 0;
	}
	.stage.right :global(.head) {
		left: auto;
		right: 0;
	}
	.stage.above :global(.head) {
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
	/* Translucent and rounded, apart from the pill: the reply sits over whatever is behind. */
	.bubble {
		min-height: 0;
		border: 1px solid var(--line);
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
		max-width: 100%;
		max-height: var(--bubble-max);
		overflow: hidden;
		background: rgb(14 16 21);
		border-color: var(--line-strong);
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
