<script lang="ts">
	// The reply bubble. It shows the current reply and is just as tall. The conversation before it
	// sits above, out of view: scroll up over the bubble (wheel, or the arrow keys once it has
	// focus) and the bubble opens to its full height to show it, with the edges fading where there
	// is more. Scrolling back down to the end closes it to the reply again.
	import { untrack } from "svelte";
	import { follow } from "../lib/follow.ts";
	import ReplyView from "./ReplyView.svelte";
	import type { MainState, Reply } from "./state.svelte.ts";
	import TranscriptList from "./TranscriptList.svelte";

	let { app, reply, max }: { app: MainState; reply: Reply; max: number } = $props();

	/** Padding above and below the reply; keep in step with the CSS. */
	const PAD_TOP = 12;
	const PAD_BOTTOM = 14;
	/** How close to an end counts as at it, px. */
	const SLACK = 4;

	let node: HTMLElement | undefined = $state();
	let current: HTMLElement | undefined = $state();
	let currentH = $state(0);
	let browsing = $state(false);
	/** Opening or closing: the height glides. (A reply growing as it streams is followed at once.) */
	let gliding = $state(false);
	let glideTimer: ReturnType<typeof setTimeout> | undefined;
	/** There is more above or below what shows. */
	let more = $state({ above: false, below: false });
	let lastTop = 0;
	/** How far the view is from the end, kept while the bubble opens. */
	let fromEnd = 0;

	const hasOlder = $derived(app.older.length > 0);
	const height = $derived(browsing ? max : Math.min(currentH + PAD_TOP + PAD_BOTTOM, max));

	const atEnd = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight <= SLACK;

	function measure() {
		if (!node || !current) return;
		// Closed, the top of the view is the top of the reply; only a reply too long to fit hides
		// some of itself above.
		const start = browsing ? 0 : current.offsetTop - PAD_TOP;
		more = { above: node.scrollTop > start + SLACK, below: !atEnd(node) };
	}

	function glide() {
		gliding = true;
		clearTimeout(glideTimer);
		glideTimer = setTimeout(() => {
			gliding = false;
		}, 280);
	}

	function open() {
		if (browsing || !hasOlder || !node) return;
		lastTop = node.scrollTop;
		fromEnd = node.scrollHeight - node.scrollTop - node.clientHeight;
		browsing = true;
		glide();
		hold();
	}

	/** While the bubble opens, what was at its bottom edge stays there: the room appears above. */
	function hold() {
		if (!node || !gliding || !browsing) return;
		node.scrollTop = lastTop = Math.max(0, node.scrollHeight - node.clientHeight - fromEnd);
		requestAnimationFrame(hold);
	}

	function close(smooth = true) {
		if (browsing && smooth) glide();
		browsing = false;
		if (node) {
			node.scrollTop = node.scrollHeight;
			lastTop = node.scrollTop;
		}
	}

	function onscroll() {
		if (!node) return;
		// Back at the end by scrolling down: the reply is all there is to show again.
		if (browsing && !gliding && node.scrollTop > lastTop && atEnd(node)) close();
		lastTop = node.scrollTop;
		measure();
	}

	function onwheel(event: WheelEvent) {
		if (gliding && browsing) fromEnd = Math.max(0, fromEnd - event.deltaY);
		else if (event.deltaY < 0) open();
	}

	function onkeydown(event: KeyboardEvent) {
		if (["ArrowUp", "PageUp", "Home"].includes(event.key)) open();
	}

	// A new reply starts closed, at its own start.
	$effect(() => {
		void reply.id;
		untrack(() => close(false));
	});

	$effect(() => {
		void height;
		void currentH;
		void app.older;
		// After layout: the fades depend on where the view ended up.
		const frame = requestAnimationFrame(measure);
		return () => cancelAnimationFrame(frame);
	});
</script>

<!-- Focusable so the keyboard can scroll it. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	class="frame"
	class:browsing
	class:gliding
	class:fade-above={more.above}
	class:fade-below={more.below}
	style:height="{height}px"
>
	<div class="view" bind:this={node} use:follow tabindex="0" role="region" aria-label="Reply, with the conversation above" {onscroll} {onwheel} {onkeydown}>
		{#if hasOlder}
			<div class="older"><TranscriptList {app} items={app.older} live={false} embedded /></div>
		{/if}
		<div class="current" bind:this={current} bind:offsetHeight={currentH}>
			<ReplyView {app} {reply} />
		</div>
	</div>
</div>

<style>
	/* Animated lengths need a registered type. */
	@property --fade-above {
		syntax: "<length>";
		inherits: false;
		initial-value: 0px;
	}
	@property --fade-below {
		syntax: "<length>";
		inherits: false;
		initial-value: 0px;
	}
	.frame {
		overflow: hidden;
	}
	.gliding {
		transition: height 260ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.view {
		position: relative;
		height: 100%;
		overflow-y: auto;
		/* The thumb's column is always there, so the text doesn't rewrap when it appears. */
		scrollbar-gutter: stable;
		padding: 12px 6px 14px 16px; /* PAD_TOP, PAD_BOTTOM */
		outline-offset: -3px;
		--fade-above: 0px;
		--fade-below: 0px;
		mask-image: linear-gradient(to bottom, transparent, #000 var(--fade-above), #000 calc(100% - var(--fade-below)), transparent);
		transition:
			--fade-above 180ms,
			--fade-below 180ms;
	}
	.fade-above .view {
		--fade-above: 28px;
	}
	.fade-below .view {
		--fade-below: 28px;
	}
	/* Closed, with nothing of the reply cut off, the thumb would only say "there is history". */
	.frame:not(.browsing):not(.fade-above):not(.fade-below) .view::-webkit-scrollbar-thumb {
		background-color: transparent;
	}
	/* The reply starts PAD_TOP below the end of what came before, which is where the closed
	   bubble's top edge is. */
	.older {
		padding-bottom: 14px;
		margin-bottom: 12px;
		border-bottom: 1px solid var(--line);
		color: var(--muted);
	}
</style>
