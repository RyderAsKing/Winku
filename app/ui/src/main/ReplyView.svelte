<script lang="ts">
	// The current reply under the bar: tools, streamed markdown, errors, memory saves.
	import Markdown from "../lib/Markdown.svelte";
	import type { MainState, Reply } from "./state.svelte.ts";

	let { app, reply }: { app: MainState; reply: Reply } = $props();

	const fixable = $derived(reply.error && (reply.error.kind === "auth" || reply.error.kind === "config"));
</script>

<div class="reply">
	{#if reply.title}
		<p class="label">{reply.title}</p>
	{/if}

	{#each reply.tools as tool (tool.toolCallId)}
		<p class="tool mono" class:failed={tool.ok === false}>
			{tool.ok === null ? "Running" : tool.ok ? "Ran" : "Failed"}
			{tool.name}<span class="summary">: {tool.summary}</span>
		</p>
	{/each}

	{#if reply.text}
		<Markdown text={reply.text} />
	{:else if !reply.done && !reply.error}
		<p class="waiting">Thinking…</p>
	{/if}

	{#if reply.aborted}
		<p class="note">Stopped.</p>
	{/if}

	{#if reply.error}
		<div class="error" role="alert">
			<p>{reply.error.message}</p>
			{#if fixable}
				<button type="button" class="link" onclick={() => app.openSettings()}>Open Settings</button>
			{/if}
		</div>
	{/if}

	{#each reply.saved ?? [] as saved (saved.saveId)}
		<p class="note">
			{saved.undone ? "Removed from memory" : "Saved to memory"}: {saved.title}
			{#if !saved.undone}
				<button type="button" class="link" onclick={() => app.undoMemory(saved.saveId)}>Undo</button>
			{/if}
		</p>
	{/each}
</div>

<style>
	.reply {
		display: grid;
		gap: 6px;
	}
	.label {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--muted);
	}
	.tool {
		margin: 0;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.tool.failed {
		color: var(--error);
	}
	.summary {
		color: var(--faint);
	}
	.waiting,
	.note {
		margin: 0;
		color: var(--muted);
		font-size: 13px;
	}
	.error {
		display: flex;
		gap: 12px;
		align-items: baseline;
		color: var(--error);
	}
	.error p {
		margin: 0;
	}
	.link {
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 0.2em;
		font-size: 13px;
	}
</style>
