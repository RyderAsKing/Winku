<script lang="ts">
	// First run: "Connect a model" inline in the bar (SPEC §3). No wizard.
	import type { ModelInfo, ProviderInfo } from "../../../../engine/src/protocol.ts";
	import {
		CUSTOM,
		DEFAULT_CUSTOM_CONTEXT,
		listModels,
		listProviders,
		PRESETS,
		providerConfig,
		type TestResult,
		testConnection,
	} from "../lib/connect.ts";
	import { shell } from "../lib/shell.ts";
	import type { MainState } from "./state.svelte.ts";

	let { app }: { app: MainState } = $props();

	let providers: ProviderInfo[] = $state([]);
	let providerId = $state("");
	let baseUrl = $state(PRESETS[0].baseUrl);
	let apiKey = $state("");
	let model = $state("");
	let models: ModelInfo[] = $state([]);
	let test: TestResult | null = $state(null);
	let busy = $state(false);

	const custom = $derived(providerId === CUSTOM);
	const keyUrl = $derived(providers.find((p) => p.id === providerId)?.keyUrl);
	const canTest = $derived(Boolean(providerId && model.trim() && (custom ? baseUrl.trim() : apiKey.trim())));

	$effect(() => {
		listProviders()
			.then((list) => {
				providers = list;
				providerId ||= list[0]?.id ?? CUSTOM;
			})
			.catch(() => {
				providerId = CUSTOM;
			});
	});

	// Refresh the model list when the provider, endpoint or key changes.
	$effect(() => {
		const provider = providerConfig(providerId, baseUrl, []);
		const key = apiKey;
		if (!providerId || (custom && !baseUrl.trim())) return;
		const timer = setTimeout(() => {
			listModels(provider, key)
				.then((list) => {
					models = list;
					if (!model && list[0]) model = list[0].id;
				})
				.catch(() => {
					models = [];
				});
		}, 300);
		return () => clearTimeout(timer);
	});

	function config(supportsImages: boolean) {
		const info = models.find((m) => m.id === model.trim());
		return providerConfig(providerId, baseUrl, [
			{ id: model.trim(), supportsImages, contextWindow: info?.contextWindow ?? DEFAULT_CUSTOM_CONTEXT },
		]);
	}

	async function runTest() {
		busy = true;
		test = await testConnection(config(false), model.trim(), apiKey);
		busy = false;
	}

	async function connect(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		test = await testConnection(config(false), model.trim(), apiKey);
		if (!test.ok || !app.settings) {
			busy = false;
			return;
		}
		if (apiKey.trim()) await shell.secretSet(apiKey.trim());
		const settings = await shell.settingsSet({
			...app.settings,
			provider: config(test.supportsImages),
			main: { id: model.trim(), thinking: app.settings.main?.thinking ?? "medium" },
		});
		busy = false;
		await app.connected(settings);
	}
</script>

<form class="connect" onsubmit={connect}>
	<h2>Connect a model</h2>

	<label>
		<span>Provider</span>
		<select aria-label="Provider" bind:value={providerId}>
			{#each providers as p (p.id)}
				<option value={p.id}>{p.name}</option>
			{/each}
			<option value={CUSTOM}>Custom OpenAI-compatible</option>
		</select>
	</label>

	{#if custom}
		<label>
			<span>Base URL</span>
			<div class="with-presets">
				<input aria-label="Base URL" bind:value={baseUrl} placeholder="http://localhost:11434/v1" spellcheck="false" />
				{#each PRESETS as preset (preset.name)}
					<button type="button" class="chip" onclick={() => (baseUrl = preset.baseUrl)}>{preset.name}</button>
				{/each}
			</div>
		</label>
	{/if}

	<label>
		<span>API key{custom ? " (optional)" : ""}</span>
		<div class="with-presets">
			<input type="password" aria-label="API key" bind:value={apiKey} autocomplete="off" spellcheck="false" placeholder={custom ? "Leave empty for local servers" : "Paste your key"} />
			{#if keyUrl}
				<button type="button" class="chip" onclick={() => shell.openExternal(keyUrl)}>Get a key</button>
			{/if}
		</div>
	</label>

	<label>
		<span>Model</span>
		<input aria-label="Model" bind:value={model} list="connect-models" placeholder="Pick or type a model id" spellcheck="false" />
		<datalist id="connect-models">
			{#each models as m (m.id)}
				<option value={m.id}>{m.name}</option>
			{/each}
		</datalist>
	</label>

	<div class="actions">
		<p class="status" class:bad={test && !test.ok} role="status">
			{#if busy}
				Testing…
			{:else if test?.ok}
				Works{test.supportsImages ? ", and it can see images." : "."}
			{:else if test}
				{test.error ?? "That didn't work."}
			{:else}
				Your key stays in Windows Credential Manager.
			{/if}
		</p>
		<button type="button" class="secondary" disabled={!canTest || busy} onclick={runTest}>Test</button>
		<button type="submit" class="primary" disabled={!canTest || busy}>Connect</button>
	</div>
</form>

<style>
	.connect {
		display: grid;
		gap: 10px;
	}
	h2 {
		margin: 0 0 2px;
		font-size: 15px;
		font-weight: 600;
	}
	label {
		display: grid;
		grid-template-columns: 82px minmax(0, 1fr);
		align-items: center;
		gap: 10px;
	}
	label > span {
		color: var(--muted);
		font-size: 13px;
	}
	input,
	select {
		width: 100%;
		min-width: 0;
		height: 32px;
		padding: 0 10px;
		border-radius: 9px;
		border: 1px solid var(--line-strong);
		background: var(--panel-raised);
		outline: none;
	}
	input:focus,
	select:focus {
		border-color: var(--focus);
	}
	.with-presets {
		flex-wrap: wrap;
		display: flex;
		gap: 6px;
		min-width: 0;
	}
	.chip {
		flex: none;
		height: 32px;
		padding: 0 10px;
		border-radius: 9px;
		border: 1px solid var(--line-strong);
		background: none;
		color: var(--muted);
		font-size: 12px;
		cursor: pointer;
	}
	.with-presets input { flex: 1; width: 0; min-width: 120px; }
	.actions {
		justify-content: flex-end;
		flex-wrap: wrap;
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 2px;
	}
	.status {
		flex: 1 0 100%;
		margin: 0;
		font-size: 12px;
		color: var(--muted);
	}
	.status.bad {
		color: var(--error);
	}
	.primary,
	.secondary {
		height: 32px;
		padding: 0 16px;
		border-radius: 999px;
		cursor: pointer;
	}
	.primary {
		border: 0;
		background: var(--accent);
		color: #041314;
		font-weight: 600;
	}
	.secondary {
		border: 1px solid var(--line-strong);
		background: none;
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
</style>
