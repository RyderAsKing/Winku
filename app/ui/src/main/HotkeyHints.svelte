<script lang="ts">
	// What each key does, shown beside the eyes while the hotkey prefix is held alone (SPEC §5).
	import type { Settings } from "../lib/settings.ts";
	import { hintsFor } from "./hints.ts";

	let { settings }: { settings: Settings } = $props();

	const hints = $derived(hintsFor(settings));
	// A second column holding one key looks stranded, so it joins the first.
	const lists = $derived(hints.actions.length && hints.other.length === 1 ? [[...hints.actions, ...hints.other]] : [hints.actions, hints.other]);
	const prefix = $derived(settings.leaderKey?.trim() || "Ctrl+Alt");
</script>

<div class="hints" role="status" aria-label="{prefix} keys">
	<p class="prefix mono">{prefix} +</p>
	<div class="columns">
		{#each lists as list, i (i)}
			{#if list.length}
				<dl>
					{#each list as hint (hint.key)}
						<dt><kbd class="mono">{hint.key}</kbd></dt>
						<dd>{hint.label}</dd>
					{/each}
				</dl>
			{/if}
		{/each}
	</div>
</div>

<style>
	.hints {
		padding: 10px 14px 12px;
	}
	.prefix {
		margin: 0 0 8px;
		color: var(--faint);
	}
	.columns {
		display: flex;
		align-items: flex-start;
		gap: 22px;
	}
	dl {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 6px 10px;
		margin: 0;
		min-width: 0;
	}
	dt {
		display: flex;
	}
	dd {
		margin: 0;
		color: var(--muted);
		font-size: 12px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	kbd {
		min-width: 22px;
		padding: 1px 6px;
		border: 1px solid var(--line-strong);
		border-bottom-width: 2px;
		border-radius: 6px;
		color: var(--text);
		text-align: center;
	}
</style>
