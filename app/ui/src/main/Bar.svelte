<script lang="ts">
	// The bar (and, with Ctrl+J, the transcript). Eyes on the left, input, then the context meter
	// and thinking level. Replies stream below. The window height follows the content in bar mode.
	import Eyes from "../lib/eyes/Eyes.svelte";
	import { shell } from "../lib/shell.ts";
	import Connect from "./Connect.svelte";
	import ReplyView from "./ReplyView.svelte";
	import type { MainState } from "./state.svelte.ts";
	import TranscriptList from "./TranscriptList.svelte";

	let { app }: { app: MainState } = $props();

	let eyes: Eyes | undefined = $state();
	let input: HTMLTextAreaElement | undefined = $state();
	let panel: HTMLElement | undefined = $state();
	let text = $state("");

	$effect(() => app.eyes.attach(eyes));

	$effect(() => {
		void app.focusTick;
		input?.focus();
	});

	// Bar mode: the window is as tall as the panel (the shell clamps it).
	$effect(() => {
		if (!panel || app.mode !== "bar") return;
		const target = panel;
		const observer = new ResizeObserver(() => void shell.windowBarHeight(Math.ceil(target.offsetHeight)));
		observer.observe(target);
		return () => observer.disconnect();
	});

	const transcript = $derived(app.mode === "transcript");
	const showBody = $derived(transcript || app.needsConnect || app.reply !== null);
	const ctx = $derived(app.contextPercent === null ? null : Math.round(app.contextPercent));
	const selectionWords = $derived(app.selectionChip ? app.selectionChip.trim().split(/\s+/).length : 0);

	function autosize() {
		if (!input) return;
		input.style.height = "auto";
		input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			if (app.needsConnect) return;
			const value = text;
			text = "";
			queueMicrotask(autosize);
			void app.submit(value);
		}
	}

	function oncontextmenu(event: MouseEvent) {
		event.preventDefault();
		void shell.contextMenu();
	}
</script>

<section class="panel" class:expanded={showBody} class:transcript bind:this={panel} aria-label="Winku">
	<div class="row">
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="eyes" {oncontextmenu}>
			<Eyes
				bind:this={eyes}
				expression={app.eyes.state}
				tint={app.tint}
				lid={app.lid}
				progress={app.download?.fraction ?? null}
				eyeSize={24}
				spacing={31}
				animate={app.eyes.animate}
				reduceMotion={app.eyes.reduceMotion}
			/>
		</div>

		<div class="field">
			{#if app.selectionChip || app.imageChip}
				<div class="chips">
					{#if app.selectionChip}
						<span class="chip">
							Selection, {selectionWords} {selectionWords === 1 ? "word" : "words"}
							<button type="button" aria-label="Remove selection" onclick={() => (app.selectionChip = null)}>×</button>
						</span>
					{/if}
					{#if app.imageChip}
						<span class="chip">
							Screenshot
							<button type="button" aria-label="Remove screenshot" onclick={() => (app.imageChip = null)}>×</button>
						</span>
					{/if}
				</div>
			{/if}
			<textarea
				bind:this={input}
				bind:value={text}
				rows="1"
				placeholder={app.listening ? "Listening…" : "Ask anything"}
				disabled={app.needsConnect}
				aria-label="Message"
				{onkeydown}
				oninput={autosize}
			></textarea>
		</div>

		{#if !app.needsConnect}
			<div class="meta">
				{#if app.updateReady}
					<button type="button" class="mono level" title="Install Winku {app.updateReady} and restart" onclick={() => shell.updateRestart()}>Restart to update</button>
				{/if}
				{#if app.download}
					<span class="mono" title="Downloading a voice model">{app.download.what === "stt" ? "Speech" : "Voice"} model {Math.round(app.download.fraction * 100)}%</span>
				{/if}
				{#if ctx !== null}<span class="mono" title="Context used">{ctx}% ctx</span>{/if}
				<button type="button" class="mono level" title="Thinking level (Ctrl+Alt+T)" onclick={() => app.cycleThinking()}>
					{app.thinking}
				</button>
			</div>
		{/if}
	</div>

	{#if showBody}
		<div class="body">
			{#if app.needsConnect}
				<div class="pad"><Connect {app} /></div>
			{:else if transcript}
				<TranscriptList {app} items={app.transcript} />
			{:else if app.reply}
				<div class="pad scroll"><ReplyView {app} reply={app.reply} /></div>
			{/if}
		</div>
	{/if}

	{#if app.toast}
		<div class="toast" role="status">
			<span>{app.toast.text}</span>
			{#if app.toast.action}
				<button type="button" onclick={app.toast.action.run}>{app.toast.action.label}</button>
			{/if}
		</div>
	{/if}
</section>

<style>
	.panel {
		max-height: min(432px, 100dvh);
		display: flex;
		flex-direction: column;
		width: 100%;
		border-radius: var(--radius-bar);
		background: var(--panel);
		border: 1px solid var(--line);
		overflow: hidden;
	}
	.panel.expanded {
		border-radius: 28px;
	}
	.panel.transcript {
		max-height: 100%;
		height: 100%;
		border-radius: 22px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 70px;
		padding: 0 18px 0 12px;
		flex: none;
	}
	.eyes {
		display: grid;
		place-items: center;
		width: 72px;
		height: 70px;
		flex: none;
	}
	.field {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 4px;
		padding: 12px 0;
	}
	textarea {
		border-radius: 4px;
		width: 100%;
		resize: none;
		border: 0;
		outline: none;
		background: none;
		font-size: 15px;
		line-height: 22px;
		padding: 0;
		max-height: 96px;
	}
	textarea::placeholder {
		color: var(--muted);
	}
	.chips {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 4px 1px 9px;
		border-radius: 999px;
		background: var(--panel-raised);
		border: 1px solid var(--line-strong);
		font-size: 12px;
		color: var(--muted);
	}
	.chip button {
		min-width: 24px;
		min-height: 24px;
		border: 0;
		background: none;
		color: var(--muted);
		cursor: pointer;
		padding: 0 4px;
		font-size: 14px;
		line-height: 1;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 0 1 auto;
		flex-wrap: wrap;
		justify-content: flex-end;
		max-width: 44%;
	}
	.level {
		border: 1px solid var(--line);
		border-radius: 999px;
		background: none;
		color: var(--muted);
		padding: 4px 8px;
		cursor: pointer;
	}
	.body {
		flex: 1;
		min-height: 0;
		border-top: 1px solid var(--line);
		overflow: auto;
	}
	.pad {
		padding: 14px 22px 18px 92px;
	}
	.transcript .pad {
		padding-left: 22px;
	}
	.scroll {
		max-height: 340px;
		overflow-y: auto;
		scrollbar-width: thin;
		scrollbar-color: var(--line-strong) transparent;
	}
	.toast {
		overflow-wrap: anywhere;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 22px 12px 92px;
		border-top: 1px solid var(--line);
		color: var(--muted);
		font-size: 13px;
		flex: none;
	}
	.transcript .toast {
		overflow-wrap: anywhere;
		padding-left: 22px;
	}
	.toast button {
		flex: none;
		min-height: 28px;
		border: 0;
		background: none;
		color: var(--accent);
		cursor: pointer;
		font-weight: 600;
	}
</style>
