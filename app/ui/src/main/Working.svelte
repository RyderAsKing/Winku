<script lang="ts">
	// What shows while the agent works and nothing has come back yet: the label shimmers and the
	// time since the ask counts up. The timer only runs while this is on screen.
	import { untrack } from "svelte";

	/** `since`: when the work started, ms since the epoch; defaults to when this appeared. */
	let { label, since }: { label: string; since?: number } = $props();

	const start = untrack(() => since ?? Date.now());
	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 100);
		return () => clearInterval(timer);
	});

	const elapsed = $derived.by(() => {
		const s = Math.max(0, (now - start) / 1000);
		return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
	});
</script>

<p class="working" role="status"><span class="shimmer">{label}</span><span class="elapsed mono" aria-hidden="true">{elapsed}</span></p>

<style>
	.working {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin: 0;
		font-size: 13px;
	}
	.elapsed {
		color: var(--faint);
		font-variant-numeric: tabular-nums;
	}
</style>
