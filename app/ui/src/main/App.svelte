<script lang="ts">
	import "../lib/theme.css";
	import Bar from "./Bar.svelte";
	import Pill from "./Pill.svelte";
	import { MainState } from "./state.svelte.ts";

	const app = new MainState();
	void app.init();

	// Outside Tauri the page shows the window on a stand-in desktop, sized like the real one.
	const framed = !("__TAURI_INTERNALS__" in window);
	const frame = $derived(
		app.mode === "pill" ? { w: 140, h: 84 } : app.mode === "bar" ? { w: 560, h: null } : { w: 420, h: 560 },
	);

	function onkeydown(event: KeyboardEvent) {
		if (event.key === "Escape") {
			event.preventDefault();
			void app.escape();
		} else if (event.key.toLowerCase() === "j" && event.ctrlKey && !event.altKey && !event.shiftKey) {
			event.preventDefault();
			void app.toggleTranscript();
		}
	}
</script>

<svelte:window {onkeydown} />

<div class="root" class:framed>
	<div class="window" style:width={framed ? `${frame.w}px` : null} style:height={framed && frame.h ? `${frame.h}px` : null}>
		{#if app.mode === "pill"}
			<Pill {app} />
		{:else}
			<Bar {app} />
		{/if}
	</div>
</div>

<style>
	:global(html),
	:global(body) {
		background: transparent;
		overflow: hidden;
	}
	.root,
	.window {
		width: 100%;
		height: 100%;
	}
	.framed {
		display: flex;
		justify-content: center;
		align-items: flex-start;
		padding-top: 72px;
		background:
			radial-gradient(circle at 20% 15%, #2d4057 0, transparent 45%),
			radial-gradient(circle at 80% 70%, #4b3a52 0, transparent 50%),
			#1b2230;
	}
	.framed .window {
		flex: none;
	}
</style>
