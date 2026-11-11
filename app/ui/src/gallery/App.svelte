<script lang="ts">
	// Dev-only gallery (served by `vite`, not part of the build): every eye state, thinking-level
	// tint and lid level at pill size, for design review and screenshots. `?animate=1` turns on
	// the loops (listening pulse, speaking bounce).
	import type { ThinkingLevel } from "../../../../engine/src/protocol.ts";
	import Eyes from "../lib/eyes/Eyes.svelte";
	import { type EyeState, lidFor, TINTS } from "../lib/eyes/look.ts";
	import "../lib/theme.css";

	const animate = new URLSearchParams(location.search).has("animate");

	const STATES: { state: EyeState; label: string }[] = [
		{ state: "idle", label: "Idle" },
		{ state: "listening", label: "Listening" },
		{ state: "thinking", label: "Thinking" },
		{ state: "speaking", label: "Speaking" },
		{ state: "happy", label: "Happy" },
		{ state: "hearts", label: "Hearts" },
		{ state: "sad", label: "Sad (mood)" },
		{ state: "surprised", label: "Surprised (mood)" },
		{ state: "pondering", label: "Pondering (mood)" },
		{ state: "error", label: "Error" },
		{ state: "cleared", label: "Cleared" },
		{ state: "sleeping", label: "Sleeping" },
	];
	const LEVELS = Object.keys(TINTS) as ThinkingLevel[];
	const CONTEXT = [0, 20, 50, 80, 100];
</script>

{#snippet face(state: EyeState, tint: string, lid: number, label: string)}
	<figure>
		<div class="pill">
			<Eyes expression={state} {tint} {lid} eyeSize={30} spacing={40} {animate} />
		</div>
		<figcaption>{label}</figcaption>
	</figure>
{/snippet}

<main>
	<h1>Winku eyes</h1>

	<section>
		<h2>States</h2>
		<div class="grid">
			{#each STATES as s (s.state)}
				{@render face(s.state, TINTS.medium, 0, s.label)}
			{/each}
		</div>
	</section>

	<section>
		<h2>Resting tint by thinking level</h2>
		<div class="grid">
			{#each LEVELS as level (level)}
				{@render face("idle", TINTS[level], 0, level)}
			{/each}
		</div>
	</section>

	<section>
		<h2>Lids by context fullness</h2>
		<div class="grid">
			{#each CONTEXT as percent (percent)}
				{@render face("idle", TINTS.medium, lidFor(percent), `${percent}% ctx`)}
			{/each}
		</div>
	</section>
</main>

<style>
	:global(body) {
		background: var(--panel);
		overflow-y: auto;
	}
	main {
		padding: 28px 32px 40px;
	}
	h1 {
		margin: 0 0 8px;
		font-size: 20px;
		font-weight: 600;
	}
	section {
		padding: 18px 0;
		border-top: 1px solid var(--line);
	}
	h2 {
		margin: 0 0 14px;
		font-size: 13px;
		font-weight: 600;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 18px 14px;
	}
	figure {
		display: grid;
		justify-items: center;
		gap: 8px;
		margin: 0;
	}
	.pill {
		display: grid;
		place-items: center;
		width: 140px;
		height: 84px;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: radial-gradient(ellipse 72% 72% at 50% 28%, var(--face-hi), var(--face-lo));
	}
	figcaption {
		font-size: 12px;
		color: var(--muted);
	}
</style>
