<script lang="ts">
	// The whole thread (Ctrl+J). Tool calls and the compaction summary are collapsed rows.
	import type { TranscriptItem } from "../../../../engine/src/protocol.ts";
	import Markdown from "../lib/Markdown.svelte";
	import ReplyView from "./ReplyView.svelte";
	import type { MainState } from "./state.svelte.ts";

	let { app, items, live = true }: { app?: MainState; items: TranscriptItem[]; live?: boolean } = $props();

	let scroller: HTMLElement | undefined = $state();
	const showLive = $derived(live && app?.reply && app.reply.kind === "prompt" && !app.reply.done);

	// Keep the newest message in view as the list grows or a reply streams.
	$effect(() => {
		void items.length;
		void app?.reply?.text;
		if (scroller) scroller.scrollTop = scroller.scrollHeight;
	});
</script>

<div class="list" bind:this={scroller}>
	{#if items.length === 0 && !showLive}
		<p class="empty">Nothing here yet.</p>
	{/if}
	{#each items as item (item.id)}
		{#if item.kind === "user"}
			<div class="user">
				<p>{item.text}</p>
				{#if item.images > 0}<span class="meta">{item.images === 1 ? "1 image" : `${item.images} images`}</span>{/if}
			</div>
		{:else if item.kind === "assistant"}
			<div class="assistant">
				<Markdown text={item.text} />
				{#if item.aborted}<p class="meta">Stopped.</p>{/if}
			</div>
		{:else if item.kind === "tool"}
			<details class="row">
				<summary class="mono" class:failed={item.ok === false}>
					{item.ok === false ? "Failed" : "Ran"}
					{item.name}<span class="faint">: {item.summary}</span>
				</summary>
				{#if item.detail}<pre>{item.detail}</pre>{/if}
			</details>
		{:else if item.kind === "compaction"}
			<details class="row">
				<summary>Earlier conversation summarized</summary>
				<div class="summary"><Markdown text={item.summary} /></div>
			</details>
		{:else if item.kind === "memory_saved"}
			<p class="note">
				{item.undone ? "Removed from memory" : "Saved to memory"}: {item.title}
				{#if !item.undone && app}
					<button type="button" class="link" onclick={() => app.undoMemory(item.saveId)}>Undo</button>
				{/if}
			</p>
		{:else if item.kind === "error"}
			<p class="error" role="alert">{item.message}</p>
		{/if}
	{/each}
	{#if showLive && app?.reply}
		<div class="assistant"><ReplyView {app} reply={app.reply} /></div>
	{/if}
</div>

<style>
	.list {
		display: flex;
		flex-direction: column;
		gap: 12px;
		height: 100%;
		overflow-y: auto;
		padding: 4px 18px 18px;
		scrollbar-width: thin;
		scrollbar-color: var(--line-strong) transparent;
	}
	.empty {
		margin: auto;
		color: var(--faint);
	}
	.user {
		align-self: flex-end;
		max-width: 85%;
		padding: 7px 12px;
		border-radius: 14px 14px 4px 14px;
		background: var(--panel-raised);
		border: 1px solid var(--line);
	}
	.user p {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.assistant {
		overflow-wrap: anywhere;
	}
	.meta,
	.note {
		margin: 0;
		font-size: 12px;
		color: var(--muted);
	}
	.row summary {
		cursor: pointer;
		color: var(--muted);
		font-size: 12px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.row summary.mono {
		font-size: 11px;
	}
	.row summary.failed {
		color: var(--error);
	}
	.faint {
		color: var(--faint);
	}
	.row pre {
		margin: 6px 0 0;
		padding: 8px 10px;
		max-height: 200px;
		overflow: auto;
		font-family: var(--mono);
		font-size: 11px;
		background: #07080c;
		border: 1px solid var(--line);
		border-radius: 8px;
		color: var(--muted);
	}
	.summary {
		margin-top: 6px;
		padding-left: 10px;
		border-left: 2px solid var(--line-strong);
		color: var(--muted);
	}
	.error {
		margin: 0;
		color: var(--error);
	}
	.link {
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 0.2em;
		font-size: 12px;
	}
</style>
