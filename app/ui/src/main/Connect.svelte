<script lang="ts">
	// First run: "Connect a model" inline in the bar (SPEC §3). No wizard.
	import type { ModelInfo, ProviderInfo } from "../../../../engine/src/protocol.ts";
	import {
		CUSTOM,
		DEFAULT_CUSTOM_CONTEXT,
		listModels,
		listProviders,
		modelOptions,
		PRESETS,
		providerConfig,
		providerOptions,
		type TestResult,
		testConnection,
	} from "../lib/connect.ts";
	import Combobox from "../lib/Combobox.svelte";
	import Select from "../lib/Select.svelte";
	import { shell } from "../lib/shell.ts";
	import type { MainState } from "./state.svelte.ts";

	let { app }: { app: MainState } = $props();

	/** Where the shell keeps the key (the OS credential store, through keyring). */
	const keyStore = navigator.userAgent.includes("Windows")
		? "Windows Credential Manager"
		: navigator.userAgent.includes("Mac")
			? "your Keychain"
			: "your system keyring";

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
	const providerList = $derived(providerOptions(providers));
	const modelList = $derived(modelOptions(models));
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

	/** A new provider has its own models: the last one's id would only fail the test. */
	function changeProvider() {
		model = "";
		models = [];
		test = null;
	}

	// Refresh the model list when the provider, endpoint or key changes.
	$effect(() => {
		const provider = providerConfig(providerId, baseUrl, []);
		const key = apiKey;
		if (!providerId || (custom && !baseUrl.trim())) return;
		const timer = setTimeout(() => {
			listModels(provider, key)
				.then((list) => {
					models = list;
					if (!model.trim() && list[0]) model = list[0].id;
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

<form class="connect" onsubmit={connect} oninput={() => (test = null)}>
	<h2>Connect a model</h2>

	<div class="field">
		<span class="name">Provider</span>
		<Select label="Provider" options={providerList} bind:value={providerId} onchange={changeProvider} inline />
	</div>

	{#if custom}
		<div class="field">
			<span class="name">Base URL</span>
			<div class="with-presets">
				<input aria-label="Base URL" bind:value={baseUrl} placeholder="http://localhost:11434/v1" spellcheck="false" />
				{#each PRESETS as preset (preset.name)}
					<button type="button" class="chip" class:on={baseUrl === preset.baseUrl} onclick={() => (baseUrl = preset.baseUrl)}>{preset.name}</button>
				{/each}
			</div>
		</div>
	{/if}

	<div class="field">
		<span class="name">API key</span>
		<div class="with-presets">
			<input type="password" aria-label="API key" bind:value={apiKey} autocomplete="off" spellcheck="false" placeholder={custom ? "Optional for local servers" : "Paste your key"} />
			{#if keyUrl}
				<button type="button" class="chip" onclick={() => shell.openExternal(keyUrl)}>Get a key</button>
			{/if}
		</div>
	</div>

	<div class="field">
		<span class="name">Model</span>
		<Combobox label="Model" options={modelList} bind:value={model} placeholder={models.length ? "Pick or type a model id" : "Type a model id"} inline />
	</div>

	<div class="actions">
		<p class="status" class:bad={test && !test.ok} role="status">
			{#if busy}
				Testing…
			{:else if test?.ok}
				Works{test.supportsImages ? ", and it can see images." : "."}
			{:else if test}
				{test.error ?? "That didn't work."}
			{:else}
				Your key stays in {keyStore}.
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
	/* The name sits level with the control's first line, so it stays put while a list is open. */
	.field {
		display: grid;
		grid-template-columns: 82px minmax(0, 1fr);
		align-items: start;
		gap: 10px;
	}
	.name {
		color: var(--muted);
		font-size: 13px;
		line-height: 32px;
		white-space: nowrap;
	}
	input {
		width: 100%;
		min-width: 0;
		height: 32px;
		padding: 0 10px 0 11px;
		border-radius: 8px;
		border: 1px solid var(--line-strong);
		background: var(--panel-raised);
		outline: none;
		font-size: 13px;
		transition: border-color 120ms ease;
	}
	input:hover {
		border-color: rgb(255 255 255 / 0.32);
	}
	input:focus,
	input:focus-visible {
		outline: none;
		border-color: var(--focus);
	}
	input::placeholder {
		color: var(--faint);
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
		border-radius: 8px;
		border: 1px solid var(--line-strong);
		background: none;
		color: var(--muted);
		font-size: 12px;
		cursor: pointer;
		transition:
			color 120ms ease,
			border-color 120ms ease;
	}
	.chip:hover {
		color: var(--text);
		border-color: rgb(255 255 255 / 0.32);
	}
	.chip.on {
		color: var(--accent);
		border-color: rgb(94 246 240 / 0.45);
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
