<script lang="ts">
	// History (SPEC §8): read and search archived threads and actions; restore one as current.
	import type { HistoryEntry, TranscriptItem } from "../../../../engine/src/protocol.ts";
	import "../lib/theme.css";
	import { onEngine, shell } from "../lib/shell.ts";
	import TranscriptList from "../main/TranscriptList.svelte";

	let query = $state("");
	let entries: HistoryEntry[] = $state([]);
	let selected: HistoryEntry | null = $state(null);
	let items: TranscriptItem[] = $state([]);
	let loading = $state(true);
	let restoring = $state(false);

	async function load() {
		loading = true;
		try {
			entries = await shell.call<HistoryEntry[]>({ type: "history_list", query: query.trim() || undefined });
		} catch {
			entries = [];
		}
		loading = false;
		if (!selected || !entries.some((e) => e.id === selected?.id)) await open(entries[0] ?? null);
	}

	async function open(entry: HistoryEntry | null) {
		selected = entry;
		items = entry ? await shell.call<TranscriptItem[]>({ type: "history_read", entryId: entry.id }).catch(() => []) : [];
	}

	async function restore() {
		if (!selected) return;
		restoring = true;
		await shell.call({ type: "history_restore", entryId: selected.id });
		restoring = false;
		await load();
	}

	$effect(() => {
		void query;
		const timer = setTimeout(load, 200);
		return () => clearTimeout(timer);
	});

	$effect(() => {
		const unlisten = onEngine((m) => {
			if (m.type === "thread_changed" || m.type === "reply_end") void load();
		});
		return () => void unlisten.then((u) => u());
	});

	const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
</script>

<main>
	<aside>
		<input type="search" bind:value={query} placeholder="Search history" aria-label="Search history" />
		<ul>
			{#each entries as entry (entry.id)}
				<li>
					<button type="button" class:active={selected?.id === entry.id} onclick={() => open(entry)}>
						<span class="title">{entry.title || "Untitled"}</span>
						<span class="meta">
							{entry.current ? "Current thread" : entry.kind === "action" ? "Action" : "Thread"}
							· {dateFormat.format(entry.updatedAt)}
						</span>
					</button>
				</li>
			{:else}
				<li class="empty">{loading ? "Loading…" : query ? "No matches." : "No history yet."}</li>
			{/each}
		</ul>
	</aside>

	<section>
		{#if selected}
			<header>
				<h1>{selected.title || "Untitled"}</h1>
				{#if selected.kind === "thread" && !selected.current}
					<button type="button" class="primary" disabled={restoring} onclick={restore}>Restore as current</button>
				{/if}
			</header>
			<div class="read"><TranscriptList {items} live={false} /></div>
		{/if}
	</section>
</main>

<style>
	:global(body) {
		background: var(--panel);
	}
	main {
		display: grid;
		grid-template-columns: 260px minmax(0, 1fr);
		height: 100%;
	}
	aside {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-right: 1px solid var(--line);
		background: #0a0b0f;
	}
	input {
		margin: 14px;
		height: 32px;
		padding: 0 10px;
		border-radius: 9px;
		border: 1px solid var(--line-strong);
		background: var(--panel-raised);
		outline: none;
	}
	input:focus {
		border-color: var(--focus);
	}
	ul {
		flex: 1;
		margin: 0;
		padding: 0 8px 12px;
		list-style: none;
		overflow-y: auto;
		scrollbar-width: thin;
		scrollbar-color: var(--line-strong) transparent;
	}
	li button {
		display: grid;
		gap: 2px;
		width: 100%;
		padding: 8px 10px;
		border: 0;
		border-radius: 9px;
		background: none;
		text-align: left;
		cursor: pointer;
	}
	li button:hover {
		background: rgb(255 255 255 / 0.03);
	}
	li button.active {
		background: var(--panel-raised);
	}
	.title {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		font-size: 13px;
	}
	.meta {
		font-size: 11px;
		color: var(--muted);
	}
	.empty {
		padding: 12px 10px;
		color: var(--faint);
		font-size: 13px;
	}
	section {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	header {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 16px 18px 12px;
		border-bottom: 1px solid var(--line);
	}
	h1 {
		flex: 1;
		margin: 0;
		font-size: 15px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.read {
		flex: 1;
		min-height: 0;
		padding-top: 12px;
	}
	.primary {
		flex: none;
		height: 30px;
		padding: 0 14px;
		border-radius: 999px;
		border: 0;
		background: var(--accent);
		color: #041314;
		font-weight: 600;
		cursor: pointer;
	}
	.primary:disabled {
		opacity: 0.45;
	}
</style>
