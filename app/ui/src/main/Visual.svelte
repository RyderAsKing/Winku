<script lang="ts">
	// One visual in a reply: the saved page in a sandboxed frame on its own origin (allow-scripts
	// only, so it can't reach the app). The page's bridge reports its height, which the frame grows
	// to, and its script errors; once it has loaded, what it measured goes back to the engine as the
	// show tool's result. The frame never scrolls; a tall page scrolls with the bubble.
	import { onDestroy } from "svelte";
	import { isBridgeMessage, type ReplyVisual, visualUrl } from "./visuals.ts";

	let { visual, onshown }: { visual: ReplyVisual; onshown: (visual: ReplyVisual, height: number, errors: string[]) => void } = $props();

	/** Heights often change right after load (fonts, a chart drawing itself): wait this long for them. */
	const SETTLE_MS = 300;
	/** A page that hasn't loaded by then is reported as it is. */
	const GIVE_UP_MS = 10_000;

	let frame: HTMLIFrameElement | undefined = $state();
	let height = $state(0);
	let loaded = $state(false);
	const errors: string[] = [];
	let settleTimer: ReturnType<typeof setTimeout> | undefined;

	function answer(extra?: string) {
		if (visual.answered) return;
		onshown(visual, height, extra ? [...errors, extra] : [...errors]);
	}

	const giveUp = setTimeout(() => answer(`The page didn't finish loading in ${GIVE_UP_MS / 1000} s.`), GIVE_UP_MS);

	function onmessage(event: MessageEvent) {
		if (!frame || event.source !== frame.contentWindow || !isBridgeMessage(event.data)) return;
		const message = event.data;
		if (message.kind === "error") {
			if (errors.length < 20) errors.push(message.message.slice(0, 300));
			return;
		}
		height = Math.max(0, Math.ceil(message.height));
		if (message.kind === "loaded") {
			loaded = true;
			clearTimeout(giveUp);
			clearTimeout(settleTimer);
			settleTimer = setTimeout(() => answer(), SETTLE_MS);
		}
	}

	onDestroy(() => {
		clearTimeout(giveUp);
		clearTimeout(settleTimer);
		answer(loaded ? undefined : "The visual was closed before it finished loading.");
	});
</script>

<svelte:window {onmessage} />

<figure class="visual" class:loaded aria-label={visual.title}>
	<iframe
		bind:this={frame}
		title={visual.title}
		src={visualUrl(visual.id)}
		sandbox="allow-scripts"
		referrerpolicy="no-referrer"
		scrolling="no"
		style:height="{height}px"
	></iframe>
</figure>

<style>
	.visual {
		margin: 4px 0;
		min-width: 0;
	}
	/* Nothing shows until the page has loaded: the finished visual arrives in one step. */
	.visual:not(.loaded) {
		visibility: hidden;
	}
	iframe {
		display: block;
		width: 100%;
		border: 0;
		background: transparent;
		color-scheme: dark;
		overflow: hidden;
	}
</style>
