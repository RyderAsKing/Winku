<script lang="ts">
	// The context meter and thinking level, with what else is pending: an update to install, a
	// voice model downloading, scheduled tasks. In the bar until the message reaches them; then
	// they float off it so the message has the whole bar: as pills of their own in the
	// strip on the pill's far side ("pills"), or, when the pill is against that screen edge, as
	// one pill beside the attachments ("merged").
	import { fly } from "svelte/transition";
	import { backOut, ms } from "../lib/motion.ts";
	import { shell } from "../lib/shell.ts";
	import type { MainState } from "./state.svelte.ts";

	let { app, look = "bar" }: { app: MainState; look?: "bar" | "pills" | "merged" } = $props();

	const ctx = $derived(app.contextPercent === null ? null : Math.round(app.contextPercent));
	const waiting = $derived(app.tasks.length);
</script>

<div class="meta" class:pills={look === "pills"} class:merged={look === "merged"}>
	{#if app.updateReady}
		<button type="button" class="mono item level" title="Install Winku {app.updateReady} and restart" onclick={() => shell.updateRestart()}>Restart to update</button>
	{/if}
	{#if app.download}
		<span class="mono item" title="Downloading a voice model">{app.download.what === "stt" ? "Speech" : "Voice"} model {Math.round(app.download.fraction * 100)}%</span>
	{/if}
	{#if waiting > 0}
		<button type="button" class="mono item level" title="Scheduled tasks" onclick={() => app.openSchedules()}>{waiting} waiting</button>
	{/if}
	{#if ctx !== null}<span class="mono item" title="Context used">{ctx}% ctx</span>{/if}
	<button type="button" class="mono item level" title="Thinking level (Ctrl+Alt+T)" onclick={() => app.cycleThinking()}>
		<!-- A new level rolls up into place, with the eyes' perk. -->
		{#key app.thinking}<span class="word" in:fly={{ y: 6, duration: ms(240), easing: backOut }}>{app.thinking}</span>{/key}
	</button>
</div>

<style>
	.word {
		display: inline-block;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--faint);
		font-size: 11px;
	}
	/* Soft filled chips, no outline. */
	.level {
		border: 0;
		border-radius: 999px;
		background: rgb(255 255 255 / 0.06);
		color: var(--muted);
		padding: 3px 9px;
		cursor: pointer;
		font-size: 11px;
	}
	/* Off the bar: pills on the dark face, CHIP_H (32 px) tall and rounded by half that. */
	.pills .item,
	.merged {
		display: flex;
		align-items: center;
		height: 32px;
		padding: 0 12px;
		border-radius: 16px;
		background: radial-gradient(ellipse 72% 90% at 50% 20%, var(--face-hi), var(--face-lo));
		animation: float-in 220ms cubic-bezier(0.3, 1.5, 0.5, 1) both;
	}
	.pills .level {
		color: var(--muted);
		transition:
			box-shadow 140ms ease,
			color 140ms ease;
	}
	/* Like the attachments beside it: the pill lights up and its label comes forward. */
	.pills .level:not(:disabled):hover {
		filter: none;
		color: var(--text);
		box-shadow: inset 0 0 0 32px rgb(255 255 255 / 0.07);
	}
	/* All in one pill: the meter, then the level as a soft chip inside it. */
	.merged {
		gap: 8px;
		padding: 0 5px 0 12px;
	}
	.merged .level {
		padding: 2px 8px;
	}
	@keyframes float-in {
		from {
			scale: 0.85;
			opacity: 0;
		}
	}
</style>
