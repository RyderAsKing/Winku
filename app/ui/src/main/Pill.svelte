<script lang="ts">
	// The resting eyes: a dark pill. Click to summon the bar, drag to move, right-click for the menu.
	import Eyes from "../lib/eyes/Eyes.svelte";
	import { shell } from "../lib/shell.ts";
	import type { MainState } from "./state.svelte.ts";

	let { app }: { app: MainState } = $props();
	let eyes: Eyes | undefined = $state();
	$effect(() => app.eyes.attach(eyes));

	let start: { x: number; y: number } | null = null;

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
		if (start) void app.summon();
		start = null;
	}

	function oncontextmenu(event: MouseEvent) {
		event.preventDefault();
		void shell.contextMenu();
	}
</script>

<button
	class="pill"
	type="button"
	aria-label="Open Winku"
	{onpointerdown}
	{onpointermove}
	{onpointerup}
	{oncontextmenu}
>
	<Eyes
		bind:this={eyes}
		expression={app.eyes.state}
		tint={app.tint}
		lid={app.lid}
		progress={app.download?.fraction ?? null}
		eyeSize={30}
		spacing={40}
		animate={app.eyes.animate}
		reduceMotion={app.eyes.reduceMotion}
	/>
</button>

<style>
	.pill {
		display: grid;
		place-items: center;
		width: 100%;
		height: 100%;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: radial-gradient(ellipse 72% 72% at 50% 28%, var(--face-hi), var(--face-lo));
		cursor: pointer;
		user-select: none;
		touch-action: none;
	}
</style>
