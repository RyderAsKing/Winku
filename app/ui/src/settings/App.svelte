<script lang="ts">
	// Settings: one column of grouped fields (SPEC §3). The Model group applies with an explicit
	// Save after a connection test; everything else saves as you change it.
	import type { ActionSpec, ModelInfo, ProviderInfo, ThinkingLevel } from "../../../../engine/src/protocol.ts";
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
	import HotkeyField from "../lib/HotkeyField.svelte";
	import { duplicates } from "../lib/hotkey.ts";
	import "../lib/theme.css";
	import { defaultSettings } from "../lib/defaults.ts";
	import type { Settings } from "../lib/settings.ts";
	import { type AltGrReport, type HotkeysStatus, onHotkeysStatus, onSettingsChanged, shell } from "../lib/shell.ts";

	const OUTPUTS: { value: ActionSpec["output"]; label: string }[] = [
		{ value: "replace", label: "Replace selection" },
		{ value: "show", label: "Show in the bar" },
		{ value: "agent", label: "Do it with tools" },
	];
	const DEFAULT_ACTIONS = defaultSettings().actions;

	const ALL_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

	let settings: Settings | null = $state(null);
	let hasKey = $state(false);
	let providers: ProviderInfo[] = $state([]);
	let models: ModelInfo[] = $state([]);
	let hotkeys: HotkeysStatus = $state({ failed: [] });
	let altGr = $state<AltGrReport | null>(null);

	// Model group draft
	let providerId = $state("");
	let baseUrl = $state("");
	let keyDraft = $state("");
	let replacingKey = $state(false);
	let mainId = $state("");
	let mainThinking: ThinkingLevel = $state("medium");
	let quickFollows = $state(true);
	let quickId = $state("");
	let quickThinking: ThinkingLevel = $state("off");
	let customContext = $state(DEFAULT_CUSTOM_CONTEXT);
	let customImages = $state(false);
	let test: TestResult | null = $state(null);
	let modelBusy = $state(false);
	let modelSaved = $state(false);

	const custom = $derived(providerId === CUSTOM);
	const keyUrl = $derived(providers.find((p) => p.id === providerId)?.keyUrl);
	const levelsFor = (id: string) => models.find((m) => m.id === id)?.thinkingLevels ?? ALL_LEVELS;

	function loadDraft(s: Settings) {
		const p = s.provider;
		providerId = p ? (p.kind === "custom" ? CUSTOM : p.id) : (providers[0]?.id ?? "");
		baseUrl = p?.kind === "custom" ? p.baseUrl : PRESETS[0].baseUrl;
		mainId = s.main?.id ?? "";
		mainThinking = s.main?.thinking ?? "medium";
		quickFollows = s.quick === null;
		quickId = s.quick?.id ?? "";
		quickThinking = s.quick?.thinking ?? "off";
		const cm = p?.kind === "custom" ? p.models.find((m) => m.id === mainId) : undefined;
		customContext = cm?.contextWindow ?? DEFAULT_CUSTOM_CONTEXT;
		customImages = cm?.supportsImages ?? false;
	}

	$effect(() => {
		void (async () => {
			const [s, key, list] = await Promise.all([shell.settingsGet(), shell.secretPresent(), listProviders().catch(() => [])]);
			providers = list;
			hasKey = key;
			settings = s;
			loadDraft(s);
		})();
		const unlisten = onSettingsChanged((s) => {
			settings = s;
			void shell.hotkeysAltGr().then((r) => (altGr = r)).catch(() => {});
		});
		void shell.hotkeysStatus().then((s) => (hotkeys = s)).catch(() => {});
		void shell.hotkeysAltGr().then((r) => (altGr = r)).catch(() => {});
		const unlistenHotkeys = onHotkeysStatus((s) => (hotkeys = s));
		return () => {
			void unlisten.then((u) => u());
			void unlistenHotkeys.then((u) => u());
		};
	});

	$effect(() => {
		const provider = providerConfig(providerId, baseUrl, []);
		const key = keyDraft;
		if (!providerId || (custom && !baseUrl.trim())) return;
		const timer = setTimeout(() => {
			listModels(provider, key)
				.then((list) => (models = list))
				.catch(() => (models = []));
		}, 300);
		return () => clearTimeout(timer);
	});

	function draftProvider(supportsImages: boolean) {
		const ids = [mainId.trim(), quickFollows ? "" : quickId.trim()].filter(Boolean);
		return providerConfig(
			providerId,
			baseUrl,
			[...new Set(ids)].map((id) => ({
				id,
				supportsImages: id === mainId.trim() ? supportsImages : (models.find((m) => m.id === id)?.supportsImages ?? false),
				contextWindow: id === mainId.trim() ? customContext : (models.find((m) => m.id === id)?.contextWindow ?? DEFAULT_CUSTOM_CONTEXT),
			})),
		);
	}

	async function runTest() {
		modelBusy = true;
		test = await testConnection(draftProvider(customImages), mainId.trim(), keyDraft);
		if (test.ok && custom) customImages = test.supportsImages;
		modelBusy = false;
	}

	async function saveModel() {
		if (!settings) return;
		modelBusy = true;
		modelSaved = false;
		if (keyDraft.trim()) {
			await shell.secretSet(keyDraft.trim());
			hasKey = true;
			keyDraft = "";
			replacingKey = false;
		}
		settings = await shell.settingsSet({
			...settings,
			provider: draftProvider(customImages),
			main: { id: mainId.trim(), thinking: mainThinking },
			quick: quickFollows ? null : { id: quickId.trim(), thinking: quickThinking },
		});
		modelBusy = false;
		modelSaved = true;
	}

	async function removeKey() {
		await shell.secretClear();
		hasKey = false;
		replacingKey = true;
	}

	// Everything outside the Model group saves on change.
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	function save(patch: Partial<Settings>, debounce = 0) {
		if (!settings) return;
		settings = { ...settings, ...patch };
		clearTimeout(saveTimer);
		const next = settings;
		saveTimer = setTimeout(() => void shell.settingsSet(next), debounce);
	}

	const hotkeyRows = $derived(
		settings
			? [
					{ label: "Open the bar, or hold to talk", get: (s: Settings) => s.hotkeys.summon, key: "summon" as const },
					...actionRows(settings),
					{ label: "Ask about the selection", get: (s: Settings) => s.hotkeys.askSelection, key: "askSelection" as const },
					{ label: "Attach a screenshot", get: (s: Settings) => s.hotkeys.screenshot, key: "screenshot" as const },
					{ label: "Clear context", get: (s: Settings) => s.hotkeys.clear, key: "clear" as const },
					{ label: "Cycle thinking level", get: (s: Settings) => s.hotkeys.cycleThinking, key: "cycleThinking" as const },
				]
			: [],
	);

	function actionRows(s: Settings) {
		return s.actions.map((action, i) => ({
			label: `Action ${i + 1}: ${action.name}`,
			get: (x: Settings) => x.hotkeys.actions[i] ?? "",
			key: i,
		}));
	}

	function setHotkey(key: (typeof hotkeyRows)[number]["key"], value: string) {
		if (!settings) return;
		const hotkeys = structuredClone($state.snapshot(settings.hotkeys));
		if (typeof key === "number") hotkeys.actions[key] = value;
		else hotkeys[key] = value;
		save({ hotkeys });
	}

	function setAction(index: number, patch: Partial<ActionSpec>, debounce = 0) {
		if (!settings) return;
		const actions = structuredClone($state.snapshot(settings.actions));
		actions[index] = { ...(actions[index] as ActionSpec), ...patch };
		save({ actions }, debounce);
	}

	const isDefault = (action: ActionSpec, index: number) => JSON.stringify(action) === JSON.stringify(DEFAULT_ACTIONS[index]);

	/** The settings field a row's binding lives in, as `hotkeys_status` names it. */
	const fieldName = (key: (typeof hotkeyRows)[number]["key"]) => (typeof key === "number" ? `action${key + 1}` : key);
	const failedFor = (key: (typeof hotkeyRows)[number]["key"]) => hotkeys.failed.find((f) => f.name === fieldName(key));
	const leaderFailed = $derived(hotkeys.failed.find((f) => f.name === "leaderKey"));
	const altGrConflicts = $derived(altGr?.altGr ? altGr.conflicts : []);

	/** Swap Ctrl+Alt for the suggested modifiers in every binding that AltGr breaks. */
	function useSuggestion() {
		if (!settings || !altGr) return;
		const from = /^ctrl\+alt\+/i;
		const swap = (v: string) => v.replace(from, `${altGr!.suggestion}+`);
		const h = structuredClone($state.snapshot(settings.hotkeys));
		save({
			hotkeys: {
				...h,
				summon: swap(h.summon),
				actions: h.actions.map(swap),
				askSelection: swap(h.askSelection),
				screenshot: swap(h.screenshot),
				clear: swap(h.clear),
				cycleThinking: swap(h.cycleThinking),
			},
		});
	}

	const dupes = $derived(settings ? duplicates(hotkeyRows.map((r) => r.get(settings as Settings))) : new Set<string>());
</script>

<main>
	<h1>Settings</h1>

	{#if settings}
		<section>
			<h2>Model</h2>
			<label class="field">
				<span>Provider</span>
				<select bind:value={providerId}>
					{#each providers as p (p.id)}
						<option value={p.id}>{p.name}</option>
					{/each}
					<option value={CUSTOM}>Custom OpenAI-compatible</option>
				</select>
			</label>

			{#if custom}
				<label class="field">
					<span>Base URL</span>
					<div class="inline">
						<input bind:value={baseUrl} spellcheck="false" />
						{#each PRESETS as preset (preset.name)}
							<button type="button" class="quiet" onclick={() => (baseUrl = preset.baseUrl)}>{preset.name}</button>
						{/each}
					</div>
				</label>
			{/if}

			<div class="field">
				<span>API key</span>
				{#if hasKey && !replacingKey}
					<div class="inline">
						<p class="value grow">Saved in Credential Manager</p>
						<button type="button" class="quiet" onclick={() => (replacingKey = true)}>Replace</button>
						<button type="button" class="quiet" onclick={removeKey}>Remove</button>
					</div>
				{:else}
					<div class="inline">
						<input type="password" bind:value={keyDraft} autocomplete="off" spellcheck="false" placeholder={custom ? "Optional for local servers" : "Paste your key"} />
						{#if keyUrl}<button type="button" class="quiet" onclick={() => shell.openExternal(keyUrl)}>Get a key</button>{/if}
					</div>
				{/if}
			</div>

			<datalist id="models">
				{#each models as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
			</datalist>

			<div class="field">
				<span>Main model</span>
				<div class="inline">
					<input bind:value={mainId} list="models" spellcheck="false" placeholder="Pick or type a model id" />
					<select bind:value={mainThinking} aria-label="Main thinking level" class="narrow">
						{#each levelsFor(mainId) as level (level)}<option value={level}>{level}</option>{/each}
					</select>
				</div>
			</div>

			<div class="field">
				<span>Quick actions</span>
				<div class="inline">
					<select bind:value={quickFollows} aria-label="Quick actions model">
						<option value={true}>Same as main model</option>
						<option value={false}>A different model</option>
					</select>
					{#if !quickFollows}
						<input bind:value={quickId} list="models" spellcheck="false" placeholder="Model id" />
						<select bind:value={quickThinking} aria-label="Quick actions thinking level" class="narrow">
							{#each levelsFor(quickId) as level (level)}<option value={level}>{level}</option>{/each}
						</select>
					{/if}
				</div>
			</div>

			{#if custom}
				<label class="field">
					<span>Context window</span>
					<input type="number" min="1024" step="1024" bind:value={customContext} class="narrow-input" />
				</label>
				<label class="field check">
					<span>Images</span>
					<span class="inline"><input type="checkbox" bind:checked={customImages} /> The main model can see images</span>
				</label>
			{/if}

			<div class="actions">
				<p class="status" class:bad={test && !test.ok} role="status">
					{#if modelBusy}Working…{:else if modelSaved}Saved.{:else if test?.ok}Works{test.supportsImages ? ", and it can see images." : "."}{:else if test}{test.error ?? "That didn't work."}{/if}
				</p>
				<button type="button" class="secondary" disabled={modelBusy || !mainId.trim()} onclick={runTest}>Test connection</button>
				<button type="button" class="primary" disabled={modelBusy || !mainId.trim()} onclick={saveModel}>Save</button>
			</div>
		</section>

		<section>
			<h2>Conversation</h2>
			<label class="field">
				<span>Compaction</span>
				<div class="inline">
					<input
						type="number"
						min="2048"
						step="1024"
						class="narrow-input"
						value={settings.compactionReserveTokens ?? 16384}
						oninput={(e) => save({ compactionReserveTokens: Number(e.currentTarget.value) || null }, 500)}
					/>
					<p class="hint">Summarize earlier messages when this many tokens of room are left.</p>
				</div>
			</label>
			<label class="field top">
				<span>Its voice</span>
				<textarea
					rows="3"
					placeholder="How Winku talks to you. For example: dry humour, no exclamation marks, British spelling."
					value={settings.assistantStyle}
					oninput={(e) => save({ assistantStyle: e.currentTarget.value }, 500)}
				></textarea>
			</label>
		</section>

		<section>
			<h2>Actions</h2>
			<p class="hint intro">Select text in any app, then press the action's key.</p>
			{#each settings.actions as action, i (i)}
				{@const key = settings.hotkeys.actions[i] || "No key"}
				<div class="action">
					<div class="field">
						<span>Action {i + 1}<br /><span class="mono key">{key}</span></span>
						<div class="inline">
							<input
								class="grow"
								aria-label="Action {i + 1} name"
								value={action.name}
								oninput={(e) => setAction(i, { name: e.currentTarget.value }, 400)}
							/>
							<select class="output" aria-label="Action {i + 1} result" value={action.output} onchange={(e) => setAction(i, { output: e.currentTarget.value as ActionSpec["output"] })}>
								{#each OUTPUTS as o (o.value)}
									<option value={o.value}>{o.label}</option>
								{/each}
							</select>
						</div>
					</div>
					<div class="field top">
						<span>
							{#if DEFAULT_ACTIONS[i] && !isDefault(action, i)}
								<button type="button" class="quiet" onclick={() => setAction(i, structuredClone(DEFAULT_ACTIONS[i] as ActionSpec))}>Reset to default</button>
							{/if}
						</span>
						<div class="stack">
							<textarea
								rows="2"
								aria-label="Action {i + 1} prompt"
								value={action.prompt}
								oninput={(e) => setAction(i, { prompt: e.currentTarget.value }, 500)}
							></textarea>
							<div class="inline wrap">
								{#if action.output !== "agent"}
									<label class="check-inline">
										<input type="checkbox" checked={action.useThreadContext} onchange={(e) => setAction(i, { useThreadContext: e.currentTarget.checked })} />
										Use the conversation as context
									</label>
								{/if}
								<label class="check-inline">
									<input type="checkbox" checked={action.useVoice} onchange={(e) => setAction(i, { useVoice: e.currentTarget.checked })} />
									Write in your voice
								</label>
							</div>
						</div>
					</div>
				</div>
			{/each}
		</section>

		<section>
			<h2>Keys</h2>
			{#if altGrConflicts.length > 0}
				<div class="notice">
					<p>Your keyboard layout uses Ctrl+Alt to type characters, so some of these keys won't work.</p>
					<button type="button" onclick={useSuggestion}>Use {altGr?.suggestion} instead</button>
				</div>
			{/if}
			{#each hotkeyRows as row (row.label)}
				{@const value = row.get(settings)}
				{@const failed = failedFor(row.key)}
				<div class="field">
					<span>{row.label}</span>
					<div class="inline">
						<HotkeyField label={row.label} {value} conflict={dupes.has(value.toLowerCase())} onchange={(v) => setHotkey(row.key, v)} />
						{#if dupes.has(value.toLowerCase())}<p class="hint bad">Used twice</p>
						{:else if failed}<p class="hint bad">Another app already uses this</p>{/if}
					</div>
				</div>
			{/each}
			<div class="field">
				<span>Leader key</span>
				<div class="inline">
					<HotkeyField label="Leader key" value={settings.leaderKey ?? "None"} onchange={(v) => save({ leaderKey: v })} />
					{#if settings.leaderKey}<button type="button" class="quiet" onclick={() => save({ leaderKey: null })}>Clear</button>{/if}
					{#if leaderFailed}<p class="hint bad">Another app already uses this</p>
					{:else}<p class="hint">Replaces Ctrl+Alt in every key above, e.g. F13.</p>{/if}
				</div>
			</div>
		</section>

		<section>
			<h2>Eyes</h2>
			<label class="field check">
				<span>Visibility</span>
				<span class="inline">
					<input type="checkbox" checked={settings.eyes.hidden} onchange={(e) => save({ eyes: { ...settings!.eyes, hidden: e.currentTarget.checked } })} />
					Hide the eyes. A tray icon appears while they're hidden.
				</span>
			</label>
		</section>
	{/if}
</main>

<style>
	:global(body) {
		background: var(--panel);
		overflow-y: auto;
	}
	main {
		max-width: 640px;
		margin: 0 auto;
		padding: 24px 28px 40px;
	}
	h1 {
		margin: 0 0 18px;
		font-size: 20px;
		font-weight: 600;
	}
	section {
		display: grid;
		gap: 10px;
		padding: 18px 0;
		border-top: 1px solid var(--line);
	}
	h2 {
		margin: 0 0 4px;
		font-size: 13px;
		font-weight: 600;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.field {
		display: grid;
		grid-template-columns: 170px 1fr;
		align-items: center;
		gap: 12px;
	}
	.field.top {
		align-items: start;
	}
	.field > span:first-child {
		color: var(--muted);
		font-size: 13px;
	}
	.inline {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	input:not([type="checkbox"]),
	select,
	textarea {
		width: 100%;
		min-width: 0;
		height: 32px;
		padding: 0 10px;
		border-radius: 9px;
		border: 1px solid var(--line-strong);
		background: var(--panel-raised);
		outline: none;
	}
	textarea {
		height: auto;
		padding: 8px 10px;
		resize: vertical;
	}
	input:focus,
	select:focus,
	textarea:focus {
		border-color: var(--focus);
	}
	.narrow {
		width: 120px;
		flex: none;
	}
	.narrow-input {
		width: 120px !important;
		flex: none;
	}
	.value,
	.hint {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
	}
	.hint {
		font-size: 12px;
	}
	.grow {
		flex: 1;
	}
	.bad {
		color: var(--error);
	}
	.notice {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 12px;
		border-radius: 10px;
		border: 1px solid var(--line-strong);
	}
	.notice p {
		flex: 1;
		margin: 0;
		font-size: 13px;
		text-wrap: pretty;
	}
	.notice button {
		flex: none;
		height: 30px;
		padding: 0 12px;
		border-radius: 8px;
		border: 1px solid var(--line-strong);
		background: var(--panel-raised);
		font-size: 12px;
		cursor: pointer;
	}
	.intro {
		margin-top: -4px;
	}
	.action {
		display: grid;
		gap: 8px;
		padding: 10px 0 12px;
	}
	.action + .action {
		border-top: 1px dashed var(--line);
	}
	.key {
		font-size: 11px;
		color: var(--muted);
	}
	.stack textarea {
		field-sizing: content;
		min-height: 52px;
	}
	.output {
		width: 170px !important;
		flex: none;
	}
	.stack {
		display: grid;
		gap: 8px;
		min-width: 0;
	}
	.wrap {
		flex-wrap: wrap;
		gap: 6px 16px;
	}
	.check-inline {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		color: var(--muted);
	}
	.quiet {
		flex: none;
		height: 30px;
		padding: 0 10px;
		border-radius: 8px;
		border: 1px solid var(--line-strong);
		background: none;
		color: var(--muted);
		font-size: 12px;
		cursor: pointer;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 4px;
	}
	.status {
		flex: 1;
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
