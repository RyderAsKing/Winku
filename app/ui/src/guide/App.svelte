<script lang="ts">
	// The floating guide (SPEC §5): the hotkey guide in its own window just above the selected
	// text. The shell sends what to show; this page draws it and reports its size, and the shell
	// then places the window and shows it. It never takes focus or clicks.
	import { tick } from "svelte";
	import "../lib/theme.css";
	import type { Settings } from "../lib/settings.ts";
	import { type GuideShowing, onGuide, onSettingsChanged, shell } from "../lib/shell.ts";
	import HotkeyHints from "../main/HotkeyHints.svelte";
	import { dimsFor } from "../main/stage.ts";

	// Outside Tauri the page shows the guide on a stand-in desktop.
	const framed = !("__TAURI_INTERNALS__" in window);

	let settings: Settings | null = $state(null);
	let showing: GuideShowing | null = $state(null);
	let bubble: HTMLElement | undefined = $state();

	void (async () => {
		await onSettingsChanged((s) => (settings = s));
		await onGuide((event) => (showing = event.show ? { id: event.id, editable: event.editable } : null));
		settings = await shell.settingsGet();
		// The event that created this window came before the page could listen.
		showing ??= await shell.guideCurrent();
	})();

	// Each guide is measured once it is drawn, and the shell sizes the window to it.
	$effect(() => {
		const shown = showing;
		if (!shown || !settings) return;
		void tick().then(() => {
			if (!bubble || showing !== shown) return;
			const box = bubble.getBoundingClientRect();
			void shell.guideSize(shown.id, Math.ceil(box.width), Math.ceil(box.height));
		});
	});
</script>

<div class="root" class:framed>
	{#if showing && settings}
		<!-- Same width limit as beside the eyes: the open bar's. -->
		<div class="bubble floating" bind:this={bubble} style:max-width="{dimsFor(settings.eyes.size).barW}px">
			<HotkeyHints {settings} selection={showing.editable ? "editable" : "read-only"} />
		</div>
	{/if}
</div>

<style>
	:global(html),
	:global(body) {
		margin: 0;
		background: transparent;
		overflow: hidden;
	}
	/* The bubble look of the guide beside the eyes (main/App.svelte, .bubble.hint-bubble). */
	.bubble {
		position: absolute;
		top: 0;
		left: 0;
		width: max-content;
		box-sizing: border-box;
		border: 1px solid var(--line-strong);
		border-radius: 18px; /* BUBBLE_RADIUS in main/stage.ts */
		background: rgb(14 16 21);
		overflow: hidden;
		overflow-wrap: anywhere;
	}
	.framed {
		position: fixed;
		inset: 0;
		background:
			radial-gradient(circle at 20% 15%, #2d4057 0, transparent 45%),
			radial-gradient(circle at 80% 70%, #4b3a52 0, transparent 50%),
			#1b2230;
	}
	.framed .bubble {
		top: 64px;
		left: 64px;
	}
</style>
