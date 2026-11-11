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
		<details class="tool mono" class:failed={tool.ok === false}>
			<summary title={tool.summary}>
			{tool.ok === null ? (reply.permissions?.some((ask) => !ask.decided) ? "Wants to run" : "Running") : tool.ok ? "Ran" : "Failed"}
			{tool.name}<span class="summary">: {tool.summary}</span>
			</summary>
			<pre>{tool.summary}</pre>
		</details>
	{/each}

	{#if reply.text}
		<Markdown text={reply.text} />
	{:else if !reply.done && !reply.error}
		<p class="waiting">{reply.permissions?.some((ask) => !ask.decided) ? "Waiting for you" : "Thinking…"}</p>
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
	{#each reply.permissions ?? [] as ask (ask.requestId)}
		<div class="ask" role="alertdialog" aria-label="Allow {ask.tool}?">
			<p class="mono">{ask.summary}</p>
			{#if ask.decided}
				<p class="note">{ask.decided === "deny" ? "Declined." : ask.decided === "always" ? "Allowed, and won't ask again." : "Allowed once."}</p>
			{:else}
				<div class="choices">
					<button type="button" class="accept" onclick={() => app.decidePermission(ask, "allow_once")}>Allow once</button>
					<button type="button" onclick={() => app.decidePermission(ask, "always")}>Always allow this command</button>
					<button type="button" onclick={() => app.decidePermission(ask, "deny")}>Deny</button>
				</div>
			{/if}
		</div>
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
	.ask {
		display: grid;
		gap: 8px;
		padding: 12px 0 0;
		border-top: 1px solid var(--line-strong);
	}
	.ask p {
		margin: 0;
		font-size: 12px;
		overflow-wrap: anywhere;
	}
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
		border-left: 2px solid var(--line-strong);
		overflow-wrap: anywhere;
		font-size: 12px;
		white-space: pre-wrap;
	}
	.choices {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.choices button {
		min-height: 32px;
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
		grid-template-columns: minmax(0, 1fr);
		min-width: 0;
		overflow-wrap: anywhere;
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
		min-width: 0;
		max-width: 100%;
		margin: 0;
		color: var(--muted);
		white-space: normal;
		overflow-wrap: anywhere;
	}
	.tool summary {
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		padding: 3px 0;
	}
	.tool pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font: inherit;
		margin: 4px 0 8px;
		padding-left: 10px;
		border-left: 2px solid var(--line-strong);
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
		flex-wrap: wrap;
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
