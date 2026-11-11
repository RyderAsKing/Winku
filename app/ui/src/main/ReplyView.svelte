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
	{#each reply.proposals ?? [] as proposal (proposal.proposalId)}
		<div class="proposal">
			<p>
				{proposal.current ? "Change" : "Create"} your <strong>{proposal.profile}</strong> voice: {proposal.reason}
			</p>
			<details>
				<summary>Show the new profile</summary>
				<pre class="mono">{proposal.content}</pre>
			</details>
			{#if proposal.decided}
				<p class="note">{proposal.decided === "accepted" ? "Saved." : "Dismissed."}</p>
			{:else}
				<div class="choices">
					<button type="button" class="accept" onclick={() => app.decideProposal(proposal, true)}>Accept</button>
					<button type="button" class="dismiss" onclick={() => app.decideProposal(proposal, false)}>Dismiss</button>
				</div>
			{/if}
		</div>
	{/each}
</div>

<style>
	.proposal {
		display: grid;
		gap: 6px;
		padding-top: 8px;
		border-top: 1px solid var(--line);
		font-size: 13px;
	}
	.proposal p {
		margin: 0;
		text-wrap: pretty;
	}
	.proposal summary {
		color: var(--muted);
		font-size: 12px;
		cursor: pointer;
	}
	.proposal pre {
		margin: 6px 0 0;
		max-height: 160px;
		overflow: auto;
		padding: 8px 10px;
		border-radius: 8px;
		background: var(--panel-raised);
		font-size: 12px;
		white-space: pre-wrap;
	}
	.choices {
		display: flex;
		gap: 8px;
	}
	.choices button {
		height: 28px;
		padding: 0 12px;
		border-radius: 8px;
		border: 1px solid var(--line-strong);
		background: none;
		font-size: 12px;
		cursor: pointer;
	}
	.choices .accept {
		background: var(--accent);
		border-color: var(--accent);
		color: #071012;
		font-weight: 600;
	}
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
