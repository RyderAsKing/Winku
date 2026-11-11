<script lang="ts">
	// Settings: a list of sections on the left, one section's grouped rows on the right (SPEC §3).
	// The Model section applies with an explicit Save after a connection test; everything else
	// saves as you change it. The URL hash names the open section (settings.html#speech).
	import type { ActionSpec, ModelInfo, ProviderInfo, ThinkingLevel, VoiceProfileInfo } from "../../../../engine/src/protocol.ts";
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
	import Switch from "../lib/Switch.svelte";
	import { duplicates } from "../lib/hotkey.ts";
	import "../lib/theme.css";
	import { defaultSettings } from "../lib/defaults.ts";
	import type { Settings } from "../lib/settings.ts";
	import {
		type AltGrReport,
		type HotkeysStatus,
		onDownloadProgress,
		onUpdateStatus,
		type UpdateStatus,
		onHotkeysStatus,
		onSettingsChanged,
		type OsVoice,
		shell,
		type VoiceModel,
		type VoiceModelId,
	} from "../lib/shell.ts";

	const OUTPUTS: { value: ActionSpec["output"]; label: string }[] = [
		{ value: "replace", label: "Replace text" },
		{ value: "show", label: "Show reply" },
		{ value: "agent", label: "Use tools" },
	];
	const DEFAULT_ACTIONS = defaultSettings().actions;

	const ALL_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

	let settings = $state<Settings | null>(null);
	let hasKey = $state(false);
	let providers: ProviderInfo[] = $state([]);
	let models: ModelInfo[] = $state([]);
	let hotkeys: HotkeysStatus = $state({ failed: [] });
	let profiles: VoiceProfileInfo[] = $state([]);
	let hasSearchKey = $state(false);
	let voiceModels: VoiceModel[] = $state([]);
	let osVoices: OsVoice[] = $state([]);
	/** Download progress by model id, 0…1. */
	let downloads: Record<string, number> = $state({});
	let voiceError = $state("");
	let update: UpdateStatus = $state({ state: "idle" });
	let version = $state("");
	const stt = $derived(voiceModels.find((m) => m.id === settings?.voice.stt));
	const neural = $derived(voiceModels.find((m) => m.id === "supertonic"));
	/** Supertonic voice numbers: 0–4 female, 5–9 male. The default, 5, is listed first. */
	const neuralVoices = [5, 6, 7, 8, 9, 0, 1, 2, 3, 4].map((n) => ({ n, name: `${n >= 5 ? "Male" : "Female"} ${(n % 5) + 1}` }));
	let searchKeyDraft = $state("");
	let newApp = $state("");
	let confirmForget = $state(false);
	let forgetResult: string | null = $state(null);
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
		void loadProfiles();
		void shell.secretPresent("search-api-key").then((has) => (hasSearchKey = has)).catch(() => {});
		void shell.hotkeysAltGr().then((r) => (altGr = r)).catch(() => {});
		const unlistenHotkeys = onHotkeysStatus((s) => (hotkeys = s));
		void loadVoice();
		void shell.updateStatus().then((s) => (update = s)).catch(() => {});
		void shell.appVersion().then((v) => (version = v)).catch(() => {});
		const unlistenUpdates = onUpdateStatus((s) => (update = s));
		const unlistenDownloads = onDownloadProgress((p) => {
			if (p.fraction >= 1 || p.fraction < 0) {
				delete downloads[p.model];
				if (p.fraction < 0) voiceError = "The download failed. Check your connection and try again.";
				void loadVoice();
			} else downloads[p.model] = p.fraction;
		});
		return () => {
			void unlisten.then((u) => u());
			void unlistenHotkeys.then((u) => u());
			void unlistenDownloads.then((u) => u());
			void unlistenUpdates.then((u) => u());
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

	async function saveSearchKey() {
		const key = searchKeyDraft.trim();
		if (!key) return;
		await shell.secretSet(key, "search-api-key");
		hasSearchKey = true;
		searchKeyDraft = "";
	}

	async function loadVoice() {
		[voiceModels, osVoices] = await Promise.all([
			shell.voiceModels().catch(() => []),
			shell.voiceOsVoices().catch(() => []),
		]);
	}

	function saveVoice(patch: Partial<Settings["voice"]>) {
		if (!settings) return;
		save({ voice: { ...settings.voice, ...patch } });
	}

	async function downloadModel(id: VoiceModelId) {
		voiceError = "";
		downloads[id] = 0;
		await shell.voiceModelDownload(id).catch((e) => {
			delete downloads[id];
			voiceError = String(e);
		});
	}

	async function removeModel(id: VoiceModelId) {
		await shell.voiceModelRemove(id).catch((e) => (voiceError = String(e)));
		await loadVoice();
	}

	/** One select for the reading voice: "neural:<0-9>", "os:" (system default) or "os:<id>". */
	function readingVoice(v: Settings["voice"]): string {
		return v.tts === "supertonic" ? `neural:${v.ttsVoice ?? 5}` : `os:${v.osVoice ?? ""}`;
	}

	function setReadingVoice(value: string) {
		if (value.startsWith("neural:")) saveVoice({ tts: "supertonic", ttsVoice: Number(value.slice(7)) });
		else saveVoice({ tts: "os", osVoice: value.slice(3) || null });
	}

	async function checkUpdates() {
		update = { state: "checking" };
		update = await shell.updateCheck().catch((e) => ({ state: "error" as const, error: String(e) }));
	}

	function updateLine(u: UpdateStatus): string {
		switch (u.state) {
			case "checking":
				return "Checking…";
			case "available":
				return `Winku ${u.version} is available.`;
			case "downloading":
				return `Downloading Winku ${u.version}…`;
			case "ready":
				return `Winku ${u.version} installs when you quit or restart.`;
			case "error":
				return `Couldn't check for updates${u.error ? `: ${u.error}` : "."}`;
			default:
				return version ? `Winku ${version}.` : "";
		}
	}

	async function removeSearchKey() {
		await shell.secretClear("search-api-key");
		hasSearchKey = false;
	}

	function removeAllowed(key: string) {
		if (!settings) return;
		save({ alwaysAllow: settings.alwaysAllow.filter((k) => k !== key) });
	}

	async function loadProfiles() {
		profiles = await shell.call<VoiceProfileInfo[]>({ type: "voice_list" }).catch(() => []);
	}

	/** Profile names to offer: the files in voice\, plus any named in settings but missing. */
	const profileNames = $derived(
		[
			...new Set([
				...profiles.map((p) => p.name),
				...(settings ? [settings.voiceProfiles.default, ...Object.values(settings.voiceProfiles.byApp)] : []),
			]),
		].filter(Boolean),
	);

	function setVoice(patch: Partial<Settings["voiceProfiles"]>) {
		if (!settings) return;
		save({ voiceProfiles: { ...structuredClone($state.snapshot(settings.voiceProfiles)), ...patch } });
	}

	function setAppProfile(app: string, profile: string | null) {
		if (!settings) return;
		const byApp = { ...settings.voiceProfiles.byApp };
		if (profile === null) delete byApp[app];
		else byApp[app] = profile;
		setVoice({ byApp });
	}

	function addApp() {
		let app = newApp.trim().toLowerCase();
		if (!app || !settings) return;
		if (!app.includes(".")) app += ".exe";
		setAppProfile(app, settings.voiceProfiles.default);
		newApp = "";
	}

	async function forgetEverything() {
		const { removed } = await shell.call<{ removed: number }>({ type: "memory_forget_all" });
		confirmForget = false;
		forgetResult = removed === 1 ? "Forgot 1 file." : `Forgot ${removed} files.`;
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
	const keysAlert = $derived(dupes.size > 0 || hotkeys.failed.length > 0 || altGrConflicts.length > 0);

	const pages = $derived([
		{ id: "model", name: "Model", desc: "The AI model Winku talks to.", alert: settings !== null && !settings.main },
		{ id: "conversation", name: "Conversation", desc: "How Winku talks to you, and when it summarizes.", alert: false },
		{ id: "tools", name: "Tools", desc: "What Winku may do on this computer.", alert: false },
		{
			id: "speech",
			name: "Speech",
			desc: `Hold ${settings?.hotkeys.summon ?? "the summon key"} to talk, and let go to send. Speech is recognised on this computer.`,
			alert: false,
		},
		{ id: "memory", name: "Memory and voice", desc: "Plain markdown files you can edit in any editor.", alert: false },
		{ id: "actions", name: "Actions", desc: "Select text in any app, then press the action's key.", alert: false },
		{ id: "keys", name: "Keys", desc: "Click a key, then press the new combination. Esc cancels.", alert: keysAlert },
		{ id: "eyes", name: "Eyes", desc: "How Winku sits on your screen.", alert: false },
		{ id: "app", name: "App", desc: "Startup and updates.", alert: false },
	]);
	const pageIds = ["model", "conversation", "tools", "speech", "memory", "actions", "keys", "eyes", "app"];
	const fromHash = () => {
		const id = location.hash.slice(1);
		return pageIds.includes(id) ? id : "model";
	};
	let page = $state(fromHash());
	let content: HTMLElement | undefined = $state();

	function go(id: string) {
		page = id;
		history.replaceState(null, "", `#${id}`);
		content?.scrollTo(0, 0);
	}
</script>

<svelte:window onhashchange={() => (page = fromHash())} />

<div class="shell">
	<nav aria-label="Settings sections">
		<p class="brand">Settings</p>
		<ul>
			{#each pages as p (p.id)}
				<li>
					<button type="button" class:current={page === p.id} aria-current={page === p.id ? "page" : undefined} onclick={() => go(p.id)}>
						{p.name}
						{#if p.alert}<span class="alert" aria-label="Needs attention"></span>{/if}
					</button>
				</li>
			{/each}
		</ul>
		{#if version}<p class="version mono">Winku {version}</p>{/if}
	</nav>

	<main bind:this={content}>
		{#if settings}
			{@const current = pages.find((p) => p.id === page) ?? pages[0]}
			<header>
				<h2>{current.name}</h2>
				<p>{current.desc}</p>
			</header>

			{#if page === "model"}
				<datalist id="models">
					{#each models as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
				</datalist>
				<div class="group">
					<div class="row">
						<div class="label"><span class="title">Provider</span></div>
						<select aria-label="Provider" bind:value={providerId}>
							{#each providers as p (p.id)}
								<option value={p.id}>{p.name}</option>
							{/each}
							<option value={CUSTOM}>Custom OpenAI-compatible</option>
						</select>
					</div>
					{#if custom}
						<div class="row stack">
							<div class="label"><span class="title">Base URL</span></div>
							<div class="inline">
								<input aria-label="Base URL" bind:value={baseUrl} spellcheck="false" />
								{#each PRESETS as preset (preset.name)}
									<button type="button" class="btn" onclick={() => (baseUrl = preset.baseUrl)}>{preset.name}</button>
								{/each}
							</div>
						</div>
					{/if}
					<div class="row">
						<div class="label">
							<span class="title">API key</span>
							{#if hasKey && !replacingKey}<span class="desc">Saved in Credential Manager</span>{/if}
						</div>
						{#if hasKey && !replacingKey}
							<div class="inline end">
								<button type="button" class="btn" onclick={() => (replacingKey = true)}>Replace</button>
								<button type="button" class="btn" onclick={removeKey}>Remove</button>
							</div>
						{:else}
							<div class="inline">
								<input type="password" aria-label="API key" bind:value={keyDraft} autocomplete="off" spellcheck="false" placeholder={custom ? "Optional for local servers" : "Paste your key"} />
								{#if keyUrl}<button type="button" class="btn" onclick={() => shell.openExternal(keyUrl)}>Get a key</button>{/if}
							</div>
						{/if}
					</div>

					<div class="row">
						<div class="label"><span class="title">Main model</span><span class="desc">Replies, tools and the conversation</span></div>
						<div class="inline">
							<input aria-label="Main model" bind:value={mainId} list="models" spellcheck="false" placeholder="Pick or type a model id" />
							<select bind:value={mainThinking} aria-label="Main thinking level" class="level">
								{#each levelsFor(mainId) as level (level)}<option value={level}>{level}</option>{/each}
							</select>
						</div>
					</div>
					<div class="row">
						<div class="label"><span class="title">Quick actions</span><span class="desc">Rewrites and other actions on selected text</span></div>
						<select bind:value={quickFollows} aria-label="Quick actions model">
							<option value={true}>Same as main model</option>
							<option value={false}>A different model</option>
						</select>
					</div>
					{#if !quickFollows}
						<div class="row">
							<div class="label"><span class="title">Quick model</span></div>
							<div class="inline">
								<input aria-label="Quick model ID" bind:value={quickId} list="models" spellcheck="false" placeholder="Model id" />
								<select bind:value={quickThinking} aria-label="Quick actions thinking level" class="level">
									{#each levelsFor(quickId) as level (level)}<option value={level}>{level}</option>{/each}
								</select>
							</div>
						</div>
					{/if}
					{#if custom}
						<div class="row">
							<div class="label"><span class="title">Context window</span><span class="desc">In tokens</span></div>
							<input type="number" min="1024" step="1024" aria-label="Context window" bind:value={customContext} class="short" />
						</div>
						<div class="row">
							<div class="label"><span class="title">Images</span><span class="desc">The main model can see images</span></div>
							<Switch label="The main model can see images" checked={customImages} onchange={(v) => (customImages = v)} />
						</div>
					{/if}
					<div class="row foot">
						<p class="status" class:bad={test && !test.ok} role="status">
							{#if modelBusy}Working…{:else if modelSaved}Saved.{:else if test?.ok}Works{test.supportsImages ? ", and it can see images." : "."}{:else if test}{test.error ?? "That didn't work."}{:else}Changes here apply when you save.{/if}
						</p>
						<div class="inline end">
							<button type="button" class="btn" disabled={modelBusy || !mainId.trim()} onclick={runTest}>Test connection</button>
							<button type="button" class="btn primary" disabled={modelBusy || !mainId.trim()} onclick={saveModel}>Save</button>
						</div>
					</div>
				</div>
			{:else if page === "conversation"}
				<div class="group">
					<div class="row">
						<div class="label">
							<span class="title">Compaction</span>
							<span class="desc">Summarize earlier messages when this many tokens of room are left.</span>
						</div>
						<input
							type="number"
							min="2048"
							step="1024"
							class="short"
							aria-label="Compaction"
							value={settings.compactionReserveTokens ?? 16384}
							oninput={(e) => save({ compactionReserveTokens: Number(e.currentTarget.value) || null }, 500)}
						/>
					</div>
					<div class="row stack">
						<div class="label"><span class="title">Its voice</span><span class="desc">How Winku talks to you.</span></div>
						<textarea
							rows="4"
							aria-label="Its voice"
							placeholder="For example: dry humour, no exclamation marks, British spelling."
							value={settings.assistantStyle}
							oninput={(e) => save({ assistantStyle: e.currentTarget.value }, 500)}
						></textarea>
					</div>
				</div>
			{:else if page === "tools"}
				<div class="group">
					<div class="row">
						<div class="label">
							<span class="title">Ask before running</span>
							<span class="desc">Check with me before Winku writes files, runs commands or opens things.</span>
						</div>
						<Switch label="Ask before running" checked={settings.askBeforeRunning} onchange={(v) => save({ askBeforeRunning: v })} />
					</div>
					{#each settings.alwaysAllow as key (key)}
						<div class="row">
							<div class="label"><span class="title">Always allowed</span><span class="desc mono allowed">{key}</span></div>
							<button type="button" class="btn" onclick={() => removeAllowed(key)}>Remove</button>
						</div>
					{/each}
				</div>
				<h3>Web search</h3>
				<div class="group">
					{#if hasSearchKey}
						<div class="row">
							<div class="label"><span class="title">Brave Search</span><span class="desc">Key saved in Credential Manager</span></div>
							<button type="button" class="btn" onclick={removeSearchKey}>Remove</button>
						</div>
					{:else}
						<div class="row stack">
							<div class="label">
								<span class="title">Brave Search key</span>
								<span class="desc">Optional. Without it Winku can still read web pages you or it link to, but can't search.</span>
							</div>
							<form class="inline" onsubmit={(e) => (e.preventDefault(), saveSearchKey())}>
								<input type="password" aria-label="Brave Search API key" autocomplete="off" spellcheck="false" placeholder="Brave Search API key" bind:value={searchKeyDraft} />
								<button type="submit" class="btn" disabled={!searchKeyDraft.trim()}>Save</button>
								<button type="button" class="btn" onclick={() => shell.openExternal("https://api-dashboard.search.brave.com/app/keys")}>Get a key</button>
							</form>
						</div>
					{/if}
				</div>
			{:else if page === "speech"}
				<h3>Listening</h3>
				<div class="group">
					<div class="row">
						<div class="label">
							<span class="title">Speech to text</span>
							{#if stt}
								<span class="desc">
									{downloads[stt.id] !== undefined || stt.downloading
										? `Downloading, ${Math.round((downloads[stt.id] ?? 0) * 100)}%.`
										: stt.installed
											? `Downloaded, ${stt.sizeMb} MB.`
											: `${stt.sizeMb} MB. Downloads the first time you hold the talk key, or now.`}
								</span>
							{/if}
						</div>
						<div class="inline">
							<select aria-label="Speech to text" value={settings.voice.stt} onchange={(e) => saveVoice({ stt: e.currentTarget.value as Settings["voice"]["stt"] })}>
								{#each voiceModels.filter((m) => m.kind === "stt") as model (model.id)}
									<option value={model.id}>{model.name}</option>
								{/each}
							</select>
							{#if stt && downloads[stt.id] === undefined && !stt.downloading}
								{#if stt.installed}
									<button type="button" class="btn" onclick={() => removeModel(stt.id)}>Remove</button>
								{:else}
									<button type="button" class="btn" onclick={() => downloadModel(stt.id)}>Download</button>
								{/if}
							{/if}
						</div>
					</div>
					<div class="row">
						<div class="label"><span class="title">Pause listening</span><span class="desc">Holding the key opens the bar instead of listening.</span></div>
						<Switch label="Pause listening" checked={settings.voice.listeningPaused} onchange={(v) => saveVoice({ listeningPaused: v })} />
					</div>
				</div>
				<h3>Reading aloud</h3>
				<div class="group">
					<div class="row">
						<div class="label"><span class="title">Read replies aloud</span></div>
						<select aria-label="Read replies aloud" value={settings.voice.reply} onchange={(e) => saveVoice({ reply: e.currentTarget.value as Settings["voice"]["reply"] })}>
							<option value="mirror">When I speak</option>
							<option value="always_voice">Always</option>
							<option value="always_text">Never</option>
						</select>
					</div>
					<div class="row">
						<div class="label"><span class="title">How much it says</span><span class="desc">The rest stays on screen.</span></div>
						<select aria-label="How much it says" value={settings.voice.say} onchange={(e) => saveVoice({ say: e.currentTarget.value as Settings["voice"]["say"] })}>
							<option value="brief">A sentence or two</option>
							<option value="enough">Enough to follow without looking</option>
							<option value="full">Everything it writes</option>
						</select>
					</div>
					<div class="row">
						<div class="label">
							<span class="title">Voice</span>
							{#if settings.voice.tts === "supertonic" && neural}
								<span class="desc">
									{downloads.supertonic !== undefined || neural.downloading
										? `Downloading the natural voice, ${Math.round((downloads.supertonic ?? 0) * 100)}%. The system voice reads until it finishes.`
										: neural.installed
											? `Downloaded, ${neural.sizeMb} MB. Frees its memory after 3 idle minutes.`
											: "Downloads the first time it reads a reply, or now. The system voice reads until then."}
								</span>
							{/if}
						</div>
						<div class="inline">
							<select aria-label="Reading voice" value={readingVoice(settings.voice)} onchange={(e) => setReadingVoice(e.currentTarget.value)}>
								{#if neural}
									<optgroup label="Natural, offline ({neural.sizeMb} MB download)">
										{#each neuralVoices as voice (voice.n)}
											<option value="neural:{voice.n}">{voice.name}</option>
										{/each}
									</optgroup>
								{/if}
								<optgroup label="System voices">
									<option value="os:">System default</option>
									{#each osVoices as voice (voice.id)}
										<option value="os:{voice.id}">{voice.name} ({voice.language})</option>
									{/each}
								</optgroup>
							</select>
							<button type="button" class="btn" onclick={() => shell.speak("Hi, I'm Winku. This is how I sound.").catch((e) => (voiceError = String(e)))}>Test</button>
						</div>
					</div>
					{#if settings.voice.tts === "supertonic" && neural && downloads.supertonic === undefined && !neural.downloading}
						<div class="row">
							<div class="label"><span class="title">Natural voice model</span></div>
							{#if neural.installed}
								<button type="button" class="btn" onclick={() => removeModel("supertonic")}>Remove</button>
							{:else}
								<button type="button" class="btn" onclick={() => downloadModel("supertonic")}>Download</button>
							{/if}
						</div>
					{/if}
				</div>
				{#if voiceError}
					<p class="message bad" role="alert">{voiceError}</p>
				{/if}
			{:else if page === "memory"}
				<div class="group">
					<div class="row">
						<div class="label"><span class="title">About me</span><span class="desc">What Winku should know about you. It only reads this.</span></div>
						<button type="button" class="btn" onclick={() => shell.openDataPath("about_me")}>Open in editor</button>
					</div>
					<div class="row">
						<div class="label"><span class="title">Memory</span><span class="desc">{forgetResult ?? "What Winku has saved from your conversations."}</span></div>
						<div class="inline end">
							<button type="button" class="btn" onclick={() => shell.openDataPath("memory")}>Open folder</button>
							{#if !confirmForget}
								<button type="button" class="btn" onclick={() => ((confirmForget = true), (forgetResult = null))}>Forget everything</button>
							{/if}
						</div>
					</div>
					{#if confirmForget}
						<div class="row confirm">
							<div class="label"><span class="title bad">Forget everything?</span><span class="desc">This deletes everything Winku remembers. About me and your voice stay.</span></div>
							<div class="inline end">
								<button type="button" class="btn" onclick={() => (confirmForget = false)}>Cancel</button>
								<button type="button" class="btn danger" onclick={forgetEverything}>Forget everything</button>
							</div>
						</div>
					{/if}
				</div>
				<h3>Your voice</h3>
				<div class="group">
					<div class="row">
						<div class="label"><span class="title">Default</span><span class="desc">Rewrites use this voice, unless an app below has its own.</span></div>
						<div class="inline">
							<select aria-label="Default voice profile" value={settings.voiceProfiles.default} onchange={(e) => setVoice({ default: e.currentTarget.value })}>
								{#each profileNames as name (name)}
									<option value={name}>{name}</option>
								{/each}
							</select>
							<button type="button" class="btn" onclick={() => shell.openDataPath("voice")}>Open folder</button>
						</div>
					</div>
					{#each Object.entries(settings.voiceProfiles.byApp) as [app, profile] (app)}
						<div class="row">
							<div class="label"><span class="title mono app">{app}</span></div>
							<div class="inline">
								<select aria-label="Voice profile for {app}" value={profile} onchange={(e) => setAppProfile(app, e.currentTarget.value)}>
									{#each profileNames as name (name)}
										<option value={name}>{name}</option>
									{/each}
								</select>
								<button type="button" class="btn" onclick={() => setAppProfile(app, null)}>Remove</button>
							</div>
						</div>
					{/each}
					<div class="row">
						<div class="label"><span class="title">Another app</span><span class="desc">Its program name, like outlook.exe</span></div>
						<form class="inline" onsubmit={(e) => (e.preventDefault(), addApp())}>
							<input aria-label="App" placeholder="outlook.exe" spellcheck="false" bind:value={newApp} />
							<button type="submit" class="btn" disabled={!newApp.trim()}>Add</button>
						</form>
					</div>
				</div>
			{:else if page === "actions"}
				{#each settings.actions as action, i (i)}
					{@const key = settings.hotkeys.actions[i] || "No key"}
					<div class="group action">
						<div class="action-head">
							<span class="mono key" title="Action {i + 1}">{key}</span>
							<input
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
						<textarea
							rows="2"
							aria-label="Action {i + 1} prompt"
							value={action.prompt}
							oninput={(e) => setAction(i, { prompt: e.currentTarget.value }, 500)}
						></textarea>
						<div class="action-foot">
							{#if action.output !== "agent"}
								<span class="toggle">
									<Switch label="Action {i + 1}: use the conversation as context" checked={action.useThreadContext} onchange={(v) => setAction(i, { useThreadContext: v })} />
									Use the conversation as context
								</span>
							{/if}
							<span class="toggle">
								<Switch label="Action {i + 1}: write in your voice" checked={action.useVoice} onchange={(v) => setAction(i, { useVoice: v })} />
								Write in your voice
							</span>
							{#if DEFAULT_ACTIONS[i] && !isDefault(action, i)}
								<button type="button" class="btn ghost" onclick={() => setAction(i, structuredClone(DEFAULT_ACTIONS[i] as ActionSpec))}>Reset to default</button>
							{/if}
						</div>
					</div>
				{/each}
			{:else if page === "keys"}
				{#if altGrConflicts.length > 0}
					<div class="notice">
						<p>Your keyboard layout uses Ctrl+Alt to type characters, so some of these keys won't work.</p>
						<button type="button" class="btn" onclick={useSuggestion}>Use {altGr?.suggestion} instead</button>
					</div>
				{/if}
				<div class="group">
					{#each hotkeyRows as row (row.label)}
						{@const value = row.get(settings)}
						{@const failed = failedFor(row.key)}
						<div class="row">
							<div class="label">
								<span class="title">{row.label}</span>
								{#if dupes.has(value.toLowerCase())}<span class="desc bad">Used twice</span>
								{:else if failed}<span class="desc bad">Another app already uses this</span>{/if}
							</div>
							<HotkeyField label={row.label} {value} conflict={dupes.has(value.toLowerCase())} onchange={(v) => setHotkey(row.key, v)} />
						</div>
					{/each}
				</div>
				<h3>Leader key</h3>
				<div class="group">
					<div class="row">
						<div class="label">
							<span class="title">Leader key</span>
							{#if leaderFailed}<span class="desc bad">Another app already uses this</span>
							{:else}<span class="desc">Replaces Ctrl+Alt in every key above, e.g. F13 on a programmable keyboard.</span>{/if}
						</div>
						<div class="inline end">
							{#if settings.leaderKey}<button type="button" class="btn ghost" onclick={() => save({ leaderKey: null })}>Clear</button>{/if}
							<HotkeyField label="Leader key" value={settings.leaderKey ?? "None"} onchange={(v) => save({ leaderKey: v })} />
						</div>
					</div>
				</div>
			{:else if page === "eyes"}
				<div class="group">
					<div class="row">
						<div class="label"><span class="title">Size</span></div>
						<select aria-label="Size" value={settings.eyes.size} onchange={(e) => save({ eyes: { ...settings!.eyes, size: e.currentTarget.value as Settings["eyes"]["size"] } })}>
							<option value="small">Small</option>
							<option value="medium">Medium</option>
							<option value="large">Large</option>
						</select>
					</div>
					<div class="row">
						<div class="label"><span class="title">Hide the eyes</span><span class="desc">A tray icon appears while they're hidden.</span></div>
						<Switch label="Hide the eyes" checked={settings.eyes.hidden} onchange={(v) => save({ eyes: { ...settings!.eyes, hidden: v } })} />
					</div>
				</div>
			{:else if page === "app"}
				<div class="group">
					<div class="row">
						<div class="label"><span class="title">Start when I sign in</span></div>
						<Switch label="Start Winku when I sign in" checked={settings.launchAtLogin} onchange={(v) => save({ launchAtLogin: v })} />
					</div>
					<div class="row">
						<div class="label">
							<span class="title">Updates</span>
							<span class="desc" class:bad={update.state === "error"}>{updateLine(update)}</span>
						</div>
						<div class="inline">
							<select aria-label="Updates" value={settings.updates} onchange={(e) => save({ updates: e.currentTarget.value as Settings["updates"] })}>
								<option value="auto">Install automatically</option>
								<option value="notify">Tell me, don't download</option>
								<option value="off">Off</option>
							</select>
							{#if update.state === "ready" || update.state === "available"}
								<button type="button" class="btn" onclick={() => shell.updateRestart()}>Restart to update</button>
							{:else}
								<button type="button" class="btn" disabled={update.state === "checking" || update.state === "downloading"} onclick={checkUpdates}>Check now</button>
							{/if}
						</div>
					</div>
				</div>
			{/if}
		{/if}
	</main>
</div>

<style>
	:global(body) {
		background: var(--panel);
		overflow: hidden;
	}
	.shell {
		display: grid;
		grid-template-columns: 188px minmax(0, 1fr);
		height: 100%;
	}

	/* ── navigation ── */
	nav {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 20px 10px 14px;
		border-right: 1px solid var(--line);
		background: #090a0e;
		overflow-y: auto;
	}
	.brand {
		margin: 0 10px 12px;
		font-size: 15px;
		font-weight: 600;
	}
	nav ul {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	nav button {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		height: 34px;
		padding: 0 10px;
		border: 0;
		border-radius: 8px;
		background: none;
		color: var(--muted);
		font-size: 13px;
		text-align: left;
		cursor: pointer;
		transition:
			background-color 120ms ease,
			color 120ms ease;
	}
	nav button:hover {
		background: rgb(255 255 255 / 0.04);
		color: var(--text);
	}
	nav button.current {
		background: rgb(255 255 255 / 0.08);
		color: var(--text);
		font-weight: 600;
	}
	.alert {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--error);
	}
	.version {
		margin: auto 10px 0;
		padding-top: 16px;
		color: var(--faint);
	}

	/* ── page ── */
	main {
		height: 100%;
		overflow-y: auto;
		padding: 26px 28px 40px;
		scrollbar-width: thin;
		scrollbar-color: var(--line-strong) transparent;
	}
	header {
		margin-bottom: 18px;
	}
	header h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 600;
		line-height: 1.3;
	}
	header p {
		margin: 4px 0 0;
		color: var(--muted);
		font-size: 13px;
	}
	h3 {
		margin: 24px 0 8px;
		color: var(--muted);
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.02em;
	}
	.group {
		border: 1px solid var(--line);
		border-radius: 12px;
		background: rgb(255 255 255 / 0.02);
	}
	.group + .group {
		margin-top: 12px;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		min-height: 56px;
		padding: 10px 16px;
	}
	.row + .row {
		border-top: 1px solid var(--line);
	}
	.row.stack {
		flex-direction: column;
		align-items: stretch;
		gap: 10px;
		padding: 12px 16px 14px;
	}
	.row > :global(:not(.label)) {
		flex: 0 1 340px;
		min-width: 0;
	}
	.row > .inline.end {
		flex: none;
	}
	.row.stack > :global(*) {
		flex: none;
	}
	.row > :global(.btn),
	.row > :global(.switch),
	.row > :global(.hotkey),
	.row > .short {
		flex: none;
	}
	.label {
		display: grid;
		gap: 2px;
		flex: 1 1 200px;
		min-width: 0;
	}
	.title {
		font-size: 13px;
	}
	.desc {
		color: var(--muted);
		font-size: 12px;
		line-height: 1.45;
		text-wrap: pretty;
	}
	.foot {
		background: rgb(255 255 255 / 0.015);
		border-radius: 0 0 12px 12px;
	}
	.status {
		flex: 1 1 auto !important;
		margin: 0;
		color: var(--muted);
		font-size: 12px;
	}
	.confirm {
		background: rgb(255 139 130 / 0.06);
	}
	.message {
		margin: 10px 2px 0;
		font-size: 12px;
	}
	.bad {
		color: var(--error);
	}
	.allowed {
		font-size: 11px;
		overflow-wrap: anywhere;
	}
	.app {
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.inline {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.inline > input,
	.inline > select {
		flex: 1 1 auto;
	}
	.inline.end {
		justify-content: flex-end;
	}

	/* ── controls ── */
	input:not([type="checkbox"]),
	select,
	textarea {
		width: 100%;
		min-width: 0;
		height: 32px;
		padding: 0 10px;
		border-radius: 8px;
		border: 1px solid var(--line-strong);
		background-color: var(--panel-raised);
		outline: none;
		font-size: 13px;
		transition: border-color 120ms ease;
	}
	select {
		appearance: none;
		padding-right: 30px;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23aaaeb9' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
		background-repeat: no-repeat;
		background-position: right 11px center;
		cursor: pointer;
	}
	select option,
	select optgroup {
		background: var(--panel-raised);
	}
	textarea {
		height: auto;
		padding: 8px 10px;
		line-height: 1.5;
		resize: vertical;
		field-sizing: content;
		min-height: 60px;
	}
	input:hover,
	select:hover,
	textarea:hover {
		border-color: rgb(255 255 255 / 0.32);
	}
	/* The border is the focus mark; an outline as well would double it. */
	input:focus,
	select:focus,
	textarea:focus {
		border-color: var(--focus);
	}
	input:focus-visible,
	select:focus-visible,
	textarea:focus-visible {
		outline: none;
	}
	input::placeholder,
	textarea::placeholder {
		color: var(--faint);
	}
	.short {
		width: 120px !important;
	}
	.level {
		flex: 0 0 112px !important;
	}
	.btn {
		flex: none;
		height: 32px;
		padding: 0 12px;
		border-radius: 8px;
		border: 1px solid var(--line-strong);
		background: var(--panel-raised);
		color: var(--text);
		font-size: 12px;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background-color 120ms ease,
			border-color 120ms ease;
	}
	.btn:hover:not(:disabled) {
		background: #1c2029;
		border-color: rgb(255 255 255 / 0.32);
	}
	.btn.primary {
		border-color: transparent;
		background: var(--accent);
		color: #041314;
		font-weight: 600;
		padding: 0 18px;
	}
	.btn.primary:hover:not(:disabled) {
		background: #8af9f5;
		border-color: transparent;
	}
	.btn.danger {
		border-color: transparent;
		background: var(--error);
		color: #1a0605;
		font-weight: 600;
	}
	.btn.danger:hover:not(:disabled) {
		background: #ffa59e;
		border-color: transparent;
	}
	.btn.ghost {
		border-color: transparent;
		background: none;
		color: var(--muted);
	}
	.btn.ghost:hover:not(:disabled) {
		background: rgb(255 255 255 / 0.05);
		color: var(--text);
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}

	/* ── actions ── */
	.action {
		display: grid;
		gap: 10px;
		padding: 14px 16px;
	}
	.action-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.key {
		flex: none;
		min-width: 84px;
		color: var(--muted);
	}
	.output {
		flex: 0 0 148px;
	}
	.action-foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 20px;
	}
	.action-foot .btn {
		margin-left: auto;
	}
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		color: var(--muted);
		font-size: 12px;
	}

	.notice {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
		margin-bottom: 12px;
		padding: 12px 16px;
		border-radius: 12px;
		border: 1px solid rgb(255 139 130 / 0.4);
		background: rgb(255 139 130 / 0.06);
	}
	.notice p {
		flex: 1;
		margin: 0;
		font-size: 13px;
	}

	/* A narrow window puts the sections in a strip along the top. */
	@media (max-width: 620px) {
		.shell {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: auto minmax(0, 1fr);
		}
		nav {
			flex-direction: row;
			align-items: center;
			padding: 10px 12px;
			border-right: 0;
			border-bottom: 1px solid var(--line);
			overflow-x: auto;
			scrollbar-width: none;
		}
		.brand,
		.version {
			display: none;
		}
		nav ul {
			display: flex;
		}
		nav button {
			white-space: nowrap;
			height: 30px;
		}
		main {
			padding: 20px 18px 32px;
		}
		.row {
			flex-wrap: wrap;
		}
		.row > :global(:not(.label)) {
			flex: 1 1 100%;
		}
		.row > :global(.btn),
		.row > :global(.switch),
		.row > :global(.hotkey) {
			flex: none;
		}
	}
</style>
