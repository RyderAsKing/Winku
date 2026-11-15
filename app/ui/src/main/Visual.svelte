<script lang="ts">
	// One visual in a reply: the saved page in a sandboxed frame on its own origin (allow-scripts
	// only, so it can't reach the app). The page's bridge reports its height, which the frame grows
	// to, and its script errors; once it has loaded, what it measured goes back to the engine as the
	// show tool's result. The frame never scrolls; a tall page scrolls with the bubble. In the
	// transcript and History a visual is shown again from its file and answers nothing; History has
	// no main window state (`app`), so there links and "Open in browser" go to the shell directly.
	// The frame and Winku pass only what isBridgeMessage lists (SPEC §3): link clicks open http(s)
	// in the browser, a click on the visual opens it larger, Esc and Ctrl+J work as in the bar, and
	// Winku's theme goes the other way. Nothing from a page sends a message or runs a tool.
	import { onDestroy } from "svelte";
	import { shell } from "../lib/shell.ts";
	import type { MainState } from "./state.svelte.ts";
	import { isBridgeMessage, isWebLink, type ReplyVisual, visualUrl } from "./visuals.ts";

	let { app, visual, large = false }: { app?: MainState; visual: ReplyVisual; large?: boolean } = $props();

	/** Winku's palette and fonts, handed to the page as CSS variables once it has loaded. */
	const THEME_VARS = ["--text", "--muted", "--accent", "--error", "--line", "--font", "--mono"];
	function sendTheme() {
		const style = getComputedStyle(document.documentElement);
		const vars: Record<string, string> = {};
		for (const name of THEME_VARS) {
			const value = style.getPropertyValue(name).trim();
			if (value) vars[name] = value;
		}
		// The frame's origin is opaque, so there is no origin to name; nothing in this is private.
		frame?.contentWindow?.postMessage({ winku: "theme", vars }, "*");
	}

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
		if (visual.answered || !app) return;
		void app.visualShown(visual, height, extra ? [...errors, extra] : [...errors]);
	}

	const giveUp = setTimeout(() => answer(`The page didn't finish loading in ${GIVE_UP_MS / 1000} s.`), GIVE_UP_MS);

	function onmessage(event: MessageEvent) {
		if (!frame || event.source !== frame.contentWindow || !isBridgeMessage(event.data)) return;
		const message = event.data;
		if (message.kind === "link") {
			if (app) void app.visualLink(message.href);
			else if (isWebLink(message.href)) void shell.openExternal(message.href).catch(() => {});
			return;
		}
		if (message.kind === "click") {
			if (app && !large) void app.openLarger(visual);
			return;
		}
		if (message.kind === "key") {
			if (app) void app.key(message);
			return;
		}
		if (message.kind === "error") {
			if (errors.length < 20) errors.push(message.message.slice(0, 300));
			return;
		}
		height = Math.max(0, Math.ceil(message.height));
		if (message.kind === "loaded") {
			loaded = true;
			sendTheme();
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
	<button type="button" class="open" onclick={() => (app ? app.openVisualInBrowser(visual) : shell.openVisual(visual.id).catch(() => {}))}>Open in browser</button>
</figure>

<style>
	.visual {
		position: relative;
		margin: 4px 0;
		min-width: 0;
	}
	/* Nothing shows until the page has loaded: the finished visual arrives in one step. */
	.visual:not(.loaded) {
		visibility: hidden;
	}
	/* A small control over the visual's corner, shown on hover or focus. */
	.open {
		position: absolute;
		top: 4px;
		right: 4px;
		padding: 3px 9px;
		border: 0;
		border-radius: 999px;
		background: rgb(14 16 21 / 0.82);
		color: var(--muted);
		font-size: 11px;
		cursor: pointer;
		opacity: 0;
		transition: opacity 120ms;
	}
	.visual:hover .open,
	.open:focus-visible {
		opacity: 1;
	}
	.open:hover {
		color: var(--text);
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
