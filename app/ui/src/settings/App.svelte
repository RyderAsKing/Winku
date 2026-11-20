<script lang="ts">
	// Settings: a list of sections on the left, one section's grouped rows on the right (SPEC §3).
	// The Model section applies with an explicit Save after a connection test; everything else
	// saves as you change it. The URL hash names the open section (settings.html#speech).
	import type {
		ActionSpec,
		ExtensionInfo,
		MemoryCore,
		MemoryLink,
		MemoryOverview,
		MemoryPreview,
		ModelInfo,
		ProviderInfo,
		TaskInfo,
		ThinkingLevel,
		VoiceProfileInfo,
	} from "../../../../engine/src/protocol.ts";
	import {
		CUSTOM,
		DEFAULT_CUSTOM_CONTEXT,
		installExtension,
		keyPlaceholder,
		listExtensions,
		listModels,
		listProviders,
		modelOptions,
		PRESETS,
		providerConfig,
		providerOptions,
		removeExtension,
		type TestResult,
		testConnection,
	} from "../lib/connect.ts";
	import Combobox from "../lib/Combobox.svelte";
	import HotkeyField from "../lib/HotkeyField.svelte";
	import Select, { type SelectOption } from "../lib/Select.svelte";
	import MemoryMap, { type Picked } from "./MemoryMap.svelte";
	import Switch from "../lib/Switch.svelte";
	import { duplicates } from "../lib/hotkey.ts";
	import "../lib/theme.css";
	import { defaultSettings } from "../lib/defaults.ts";
	import type { Settings } from "../lib/settings.ts";
	import {
		type AltGrReport,
		type HotkeysStatus,
		type MemoryModel,
		onDownloadProgress,
		onEngine,
		onUpdateStatus,
		type UpdateStatus,
		onHotkeysStatus,
		onSettingsChanged,
		onTasksChanged,
		onUi,
		isTauri,
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
	let tasks: TaskInfo[] = $state([]);

	// Memory page
	let memory = $state<MemoryOverview | null>(null);
	let memoryModel = $state<MemoryModel | null>(null);
	/** The search model's download, 0…1, while it runs. */
	let memoryDownload = $state<number | null>(null);
	let memoryError = $state("");
	/** Profile, goals and recap as edited; a field being typed in isn't overwritten by a reload. */
	let cores: Record<MemoryCore, string> = $state({ profile: "", goals: "", recap: "" });
	let editingCore = $state<MemoryCore | null>(null);
	const coreTimers: Partial<Record<MemoryCore, ReturnType<typeof setTimeout>>> = {};
	let tidying = $state(false);
	let tidyNote = $state("");
	let allNotes = $state(false);
	const NOTES_SHOWN = 6;
	const notesShown = $derived(memory ? (allNotes ? memory.notes : memory.notes.slice(0, NOTES_SHOWN)) : []);
	/** Notes as a list, or as a map of topics with notes that mean similar things linked. */
	let notesView = $state<"list" | "map">("list");
	let memoryLinks = $state<MemoryLink[]>([]);
	let picked = $state<Picked | null>(null);
	let map = $state<ReturnType<typeof MemoryMap>>();
	/** Try a message: what Winku would add to it, without sending it. */
	let tryText = $state("");
	let preview = $state<MemoryPreview | null>(null);
	let previewing = $state(false);

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
	const currentProvider = $derived(providers.find((p) => p.id === providerId));
	const keyUrl = $derived(currentProvider?.keyUrl);
	const levelsFor = (id: string) => models.find((m) => m.id === id)?.thinkingLevels ?? ALL_LEVELS;
	const levelOptions = (id: string): SelectOption<ThinkingLevel>[] => levelsFor(id).map((level) => ({ value: level, label: level }));
	const providerList = $derived(providerOptions(providers));
	const modelList = $derived(modelOptions(models));
	/** Set when the provider is changed here: its models replace the last provider's ids. */
	let providerChanged = false;

	// Provider extensions
	let extensions: ExtensionInfo[] = $state([]);
	let extensionSource = $state("");
	let extensionBusy = $state("");
	let extensionNote = $state("");
	let extensionFailed = $state(false);

	async function refreshProviders() {
		[providers, extensions] = await Promise.all([listProviders().catch(() => providers), listExtensions().catch(() => extensions)]);
	}

	async function addExtension(event: SubmitEvent) {
		event.preventDefault();
		const source = extensionSource.trim();
		if (!source || extensionBusy) return;
		extensionBusy = "install";
		extensionNote = "";
		extensionFailed = false;
		try {
			const added = await installExtension(source);
			extensionSource = "";
			await refreshProviders();
			const names = added.providers.map((p) => p.name).join(", ");
			extensionNote = `Installed. Pick ${names} under Provider above.`;
		} catch (error) {
			extensionFailed = true;
			extensionNote = String(error).replace(/^Error: /, "");
		}
		extensionBusy = "";
	}

	async function dropExtension(name: string) {
		extensionBusy = name;
		extensionNote = "";
		extensionFailed = false;
		try {
			await removeExtension(name);
			await refreshProviders();
		} catch (error) {
			extensionFailed = true;
			extensionNote = String(error).replace(/^Error: /, "");
		}
		extensionBusy = "";
	}

	function changeProvider() {
		providerChanged = true;
		test = null;
		modelSaved = false;
	}

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
			const [s, key, list, installed] = await Promise.all([
				shell.settingsGet(),
				shell.secretPresent(),
				listProviders().catch(() => []),
				listExtensions().catch(() => []),
			]);
			providers = list;
			extensions = installed;
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
		void shell.tasksList().then((t) => (tasks = t)).catch(() => {});
		const unlistenTasks = onTasksChanged((t) => (tasks = t));
		const unlistenUi = onUi((e) => {
			if (e.kind === "settings_section") go(e.section);
		});
		void loadMemory();
		const unlistenEngine = onEngine((m) => {
			if (m.type === "memory_changed" || m.type === "memory_saved") void loadMemory();
			else if (m.type === "memory_tidy") {
				tidying = m.state === "running";
				if (m.state === "failed") tidyNote = m.message ? `The last tidy failed: ${m.message}` : "The last tidy failed.";
				if (m.state === "done") void loadMemory();
			}
		});
		// Notes saved in a conversation while this window was in the background.
		const onFocus = () => void loadMemory();
		window.addEventListener("focus", onFocus);
		const unlistenDownloads = onDownloadProgress((p) => {
			if (p.what === "embed") {
				if (p.fraction >= 1 || p.fraction < 0) {
					memoryDownload = null;
					if (p.fraction < 0) memoryError = "The download failed. Check your connection and try again.";
					void loadMemory();
				} else memoryDownload = p.fraction;
				return;
			}
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
			void unlistenTasks.then((u) => u());
			void unlistenUi.then((u) => u());
			void unlistenEngine.then((u) => u());
			window.removeEventListener("focus", onFocus);
			for (const timer of Object.values(coreTimers)) clearTimeout(timer);
		};
	});

	$effect(() => {
		const provider = providerConfig(providerId, baseUrl, []);
		const key = keyDraft;
		if (!providerId || (custom && !baseUrl.trim())) return;
		const timer = setTimeout(() => {
			listModels(provider, key)
				.then((list) => {
					models = list;
					if (!providerChanged) return;
					providerChanged = false;
					const ids = new Set(list.map((m) => m.id));
					if (!ids.has(mainId.trim())) mainId = list[0]?.id ?? "";
					if (!ids.has(quickId.trim())) quickId = "";
				})
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
					{ label: "Bring Winku here", get: (s: Settings) => s.hotkeys.bring, key: "bring" as const },
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

	const profileOptions = $derived(
		profileNames.map((name) => ({ value: name, label: name, hint: profiles.find((p) => p.name === name)?.summary })),
	);

	/** The reading voice picker: the natural voices (when offered), then the system's. */
	const voiceOptions = $derived<SelectOption<string>[]>([
		...(neural ? neuralVoices.map((v) => ({ value: `neural:${v.n}`, label: v.name, group: `Natural, offline (${neural.sizeMb} MB download)` })) : []),
		{ value: "os:", label: "System default", group: "System voices" },
		...osVoices.map((v) => ({ value: `os:${v.id}`, label: v.name, hint: v.language, group: "System voices" })),
	]);

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
		tidyNote = "";
		await loadMemory();
	}

	async function loadMemory() {
		const [overview, model] = await Promise.all([
			shell.call<MemoryOverview>({ type: "memory_overview" }).catch(() => null),
			shell.memoryModelStatus().catch(() => null),
		]);
		memoryModel = model;
		if (model?.downloading && memoryDownload === null) memoryDownload = 0;
		if (!overview) return;
		if (notesView === "map") await loadLinks();
		memory = overview;
		tidying = overview.tidying;
		for (const which of ["profile", "goals", "recap"] as const) {
			if (editingCore !== which && coreTimers[which] === undefined) cores[which] = overview[which];
		}
	}

	async function previewMessage() {
		const text = tryText.trim();
		if (!text) return;
		previewing = true;
		memoryError = "";
		try {
			preview = await shell.call<MemoryPreview>({ type: "memory_preview", text });
		} catch (e) {
			memoryError = String(e);
		} finally {
			previewing = false;
		}
	}

	function previewLine(p: MemoryPreview): string {
		const t = p.trace;
		if (!p.recallOn) return "Bringing up related notes is off, so messages carry only what's always in the prompt.";
		if (t.why === "no notes") return "There are no notes to search yet.";
		// The browser preview's engine is a stand-in that scores shared words, not the search model.
		const mock = isTauri ? "" : " This is the browser preview: its scores are made up from shared words, not the app's search model.";
		if (t.why === "the message has no words worth searching for") return `Nothing to search for: the message has no words worth looking up, so no notes are added.${mock}`;
		const took = `${t.ms} ms`;
		if (t.byMeaning) return `Searched your notes by meaning and keywords in ${took}. Nothing was sent to the model.${mock}`;
		return `Searched by keywords only in ${took}: ${t.why ?? "no search model"}. Nothing was sent to the model.${mock}`;
	}

	function hitMeta(hit: MemoryPreview["trace"]["considered"][number]): string {
		const parts = [];
		if (hit.similarity !== undefined) parts.push(`similarity ${hit.similarity.toFixed(2)}`);
		if (hit.keyword) parts.push("keyword match");
		if (hit.namedTopic) parts.push("topic named in the message");
		return parts.length ? ` · ${parts.join(", ")}` : "";
	}

	async function loadLinks() {
		const result = await shell.call<{ links: MemoryLink[] }>({ type: "memory_map" }).catch(() => null);
		memoryLinks = result?.links ?? [];
	}

	async function showNotesAs(view: "list" | "map") {
		if (view === "map") await loadLinks();
		notesView = view;
	}

	function saveMemory(patch: Partial<Settings["memory"]>) {
		if (!settings) return;
		save({ memory: { ...settings.memory, ...patch } });
	}

	/** Profile, goals or recap: written a moment after typing stops, and when the field loses focus. */
	function editCore(which: MemoryCore, text: string, delay = 600) {
		cores[which] = text;
		clearTimeout(coreTimers[which]);
		coreTimers[which] = setTimeout(() => {
			coreTimers[which] = undefined;
			memoryError = "";
			shell.call({ type: "memory_core_set", which, text }).catch((e) => (memoryError = String(e)));
		}, delay);
	}

	function flushCore(which: MemoryCore) {
		editingCore = null;
		if (coreTimers[which] !== undefined) editCore(which, cores[which], 0);
	}

	async function deleteNote(topic: string, noteId: string) {
		memoryError = "";
		await shell.call({ type: "memory_note_delete", topic, noteId }).catch((e) => (memoryError = String(e)));
		await loadMemory();
	}

	async function tidyNow() {
		tidying = true;
		tidyNote = "";
		try {
			const { changed } = await shell.call<{ changed: boolean }>({ type: "memory_tidy" });
			tidyNote = changed ? "Updated just now." : "Nothing new worth keeping.";
		} catch (e) {
			tidyNote = `The tidy failed: ${String(e)}`;
		} finally {
			tidying = false;
			await loadMemory();
		}
	}

	async function downloadMemoryModel() {
		memoryError = "";
		memoryDownload = 0;
		await shell.memoryModelDownload().catch((e) => {
			memoryDownload = null;
			memoryError = String(e);
		});
	}

	async function removeMemoryModel() {
		await shell.memoryModelRemove().catch((e) => (memoryError = String(e)));
		await loadMemory();
	}

	function modelLine(model: MemoryModel): string {
		if (memoryDownload !== null) return `Downloading, ${Math.round(memoryDownload * 100)}%. Until it finishes, notes are matched by their words.`;
		if (model.installed) return `Downloaded, ${model.sizeMb} MB. Finds notes by meaning, on this computer.`;
		return `Finds notes by meaning, on this computer. A ${model.sizeMb} MB download; until then notes are matched by their words.`;
	}

	function tidyLine(): string {
		if (tidying) return "Tidying now…";
		if (tidyNote) return tidyNote;
		const last = memory?.lastTidy;
		const when = last ? ` Last done ${ago(last)}.` : "";
		return `When a conversation goes quiet or is cleared, the Quick actions model updates your profile, goals and recap.${when}`;
	}

	/** Notes are dated by the day: "today", "yesterday", "3 days ago", or a date. */
	function noteDay(at: number): string {
		const days = Math.round((new Date().setHours(12, 0, 0, 0) - new Date(at).setHours(12, 0, 0, 0)) / 86_400_000);
		if (days <= 0) return "today";
		if (days === 1) return "yesterday";
		if (days < 14) return `${days} days ago`;
		return new Date(at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
	}

	/** "just now", "12 minutes ago", "yesterday", "3 days ago", or a date. */
	function ago(at: number): string {
		const minutes = Math.round((Date.now() - at) / 60_000);
		if (minutes < 1) return "just now";
		if (minutes < 60) return minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
		const hours = Math.round(minutes / 60);
		if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
		const days = Math.round(hours / 24);
		if (days === 1) return "yesterday";
		if (days < 14) return `${days} days ago`;
		return new Date(at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
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
				bring: swap(h.bring),
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
		{
			id: "schedules",
			name: "Schedules",
			desc: "Reminders, loops and watches Winku set up when you asked. They run while Winku is open.",
			alert: false,
		},
		{ id: "app", name: "App", desc: "Startup and updates.", alert: false },
	]);
	const pageIds = ["model", "conversation", "tools", "speech", "memory", "actions", "keys", "eyes", "schedules", "app"];
	const fromHash = () => {
		// open_window with a section opens settings.html?section=… (window.rs); the hash wins after that.
		const id = location.hash.slice(1) || (new URLSearchParams(location.search).get("section") ?? "");
		return pageIds.includes(id) ? id : "model";
	};
	let page = $state(fromHash());
	let content: HTMLElement | undefined = $state();

	/** "Every 2 minutes · next at 14:22 · 3 runs", or "Watching: build fails". */
	function taskLine(task: TaskInfo): string {
		const parts: string[] = [];
		if (task.kind === "watch") parts.push(task.description ? `Watching: ${task.description}` : "Watching");
		else if (task.kind === "timer") parts.push("Once");
		else if (task.selfPaced) parts.push("Self-paced");
		else if (task.everyMs) parts.push(`Every ${duration(task.everyMs)}`);
		if (task.status === "running") parts.push("running now");
		else if (task.status === "waiting") parts.push("waiting for your answer");
		else if (task.status === "due") parts.push("due, waiting for Winku to be free");
		else if (task.nextRunAt) parts.push(`next at ${clock(task.nextRunAt)}`);
		if (task.runs > 0) parts.push(task.runs === 1 ? "1 run" : `${task.runs} runs`);
		return parts.join(" · ");
	}

	function duration(ms: number): string {
		const s = Math.round(ms / 1000);
		if (s % 86400 === 0) return s === 86400 ? "day" : `${s / 86400} days`;
		if (s % 3600 === 0) return s === 3600 ? "hour" : `${s / 3600} hours`;
		if (s % 60 === 0) return s === 60 ? "minute" : `${s / 60} minutes`;
		return `${s} seconds`;
	}

	function clock(at: number): string {
		const date = new Date(at);
		const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
	}

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
				<div class="group">
					<div class="row">
						<div class="label"><span class="title">Provider</span></div>
						<Select label="Provider" options={providerList} bind:value={providerId} onchange={changeProvider} />
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
					{#if currentProvider?.signedIn}
						<div class="row">
							<div class="label"><span class="title">Sign-in</span><span class="desc">{currentProvider.signedIn}, through {currentProvider.extension}. No key needed.</span></div>
						</div>
					{:else}
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
									<input type="password" aria-label="API key" bind:value={keyDraft} autocomplete="off" spellcheck="false" placeholder={keyPlaceholder(currentProvider, custom)} />
									{#if keyUrl}<button type="button" class="btn" onclick={() => shell.openExternal(keyUrl)}>Get a key</button>{/if}
								</div>
							{/if}
						</div>
					{/if}

					<div class="row">
						<div class="label"><span class="title">Main model</span><span class="desc">Replies, tools and the conversation</span></div>
						<div class="inline">
							<Combobox label="Main model" options={modelList} bind:value={mainId} placeholder="Pick or type a model id" />
							<Select class="level" label="Main thinking level" options={levelOptions(mainId)} bind:value={mainThinking} />
						</div>
					</div>
					<div class="row">
						<div class="label"><span class="title">Quick actions</span><span class="desc">Rewrites and other actions on selected text</span></div>
						<Select
							label="Quick actions model"
							options={[
								{ value: true, label: "Same as main model" },
								{ value: false, label: "A different model" },
							]}
							bind:value={quickFollows}
						/>
					</div>
					{#if !quickFollows}
						<div class="row">
							<div class="label"><span class="title">Quick model</span></div>
							<div class="inline">
								<Combobox label="Quick model ID" options={modelList} bind:value={quickId} placeholder="Pick or type a model id" />
								<Select class="level" label="Quick actions thinking level" options={levelOptions(quickId)} bind:value={quickThinking} />
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

				<h3>Provider extensions</h3>
				<div class="group">
					{#each extensions as extension (extension.name)}
						<div class="row">
							<div class="label">
								<span class="title">{extension.name}{extension.version ? ` ${extension.version}` : ""}</span>
								{#if extension.error}
									<span class="desc bad">{extension.error}</span>
								{:else}
									<span class="desc">Adds {extension.providers.map((p) => p.name).join(", ")}</span>
								{/if}
							</div>
							<button type="button" class="btn" disabled={!!extensionBusy} onclick={() => dropExtension(extension.name)}>
								{extensionBusy === extension.name ? "Removing…" : "Remove"}
							</button>
						</div>
					{/each}
					<form class="row stack" onsubmit={addExtension}>
						<div class="label">
							<span class="title">Add an extension</span>
							<span class="desc">A pi package that adds model providers, like https://github.com/earendil-works/pi-claude-code for a Claude subscription. It runs on this computer with your permissions, so add only ones you trust.</span>
						</div>
						<div class="inline">
							<input aria-label="Extension to install" bind:value={extensionSource} placeholder="npm package, GitHub URL or folder" spellcheck="false" autocomplete="off" />
							<button type="submit" class="btn" disabled={!!extensionBusy || !extensionSource.trim()}>{extensionBusy === "install" ? "Installing…" : "Install"}</button>
						</div>
					</form>
					{#if extensionNote}
						<div class="row foot">
							<p class="status" class:bad={extensionFailed} role="status">{extensionNote}</p>
						</div>
					{/if}
				</div>
			{:else if page === "conversation"}
				<div class="group">
					<div class="row">
						<div class="label">
							<span class="title">Context size</span>
							<span class="desc">The most tokens the conversation can use. A model with a smaller window uses its own.</span>
						</div>
						<input
							type="number"
							min="16384"
							step="10000"
							class="short"
							aria-label="Context size"
							value={settings.contextLimit}
							oninput={(e) => {
								const value = Number(e.currentTarget.value);
								if (value >= 16384) save({ contextLimit: Math.round(value) }, 500);
							}}
						/>
					</div>
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
							<Select
								label="Speech to text"
								options={voiceModels.filter((m) => m.kind === "stt").map((m) => ({ value: m.id as Settings["voice"]["stt"], label: m.name, hint: `${m.sizeMb} MB${m.installed ? ", downloaded" : ""}` }))}
								value={settings.voice.stt}
								onchange={(stt) => saveVoice({ stt })}
							/>
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
						<Select
							label="Read replies aloud"
							options={[
								{ value: "mirror", label: "When I speak", hint: "Spoken messages get spoken replies" },
								{ value: "always_voice", label: "Always" },
								{ value: "always_text", label: "Never" },
							] satisfies SelectOption<Settings["voice"]["reply"]>[]}
							value={settings.voice.reply}
							onchange={(reply) => saveVoice({ reply })}
						/>
					</div>
					<div class="row">
						<div class="label"><span class="title">How much it says</span><span class="desc">The rest stays on screen.</span></div>
						<Select
							label="How much it says"
							options={[
								{ value: "brief", label: "A sentence or two" },
								{ value: "enough", label: "Enough to follow without looking" },
								{ value: "full", label: "Everything it writes" },
							] satisfies SelectOption<Settings["voice"]["say"]>[]}
							value={settings.voice.say}
							onchange={(say) => saveVoice({ say })}
						/>
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
							<Select label="Reading voice" options={voiceOptions} value={readingVoice(settings.voice)} onchange={setReadingVoice} />
							<button type="button" class="btn" onclick={() => shell.speak("Hi, I'm Winku. This is how I sound.").catch((e) => (voiceError = String(e)))}>Test</button>
						</div>
					</div>
					{#if settings.voice.tts === "supertonic"}
						<div class="row">
							<div class="label"><span class="title">Pace</span></div>
							<Select
								label="Pace"
								options={[
									{ value: 0.95, label: "Slower" },
									{ value: 1.05, label: "Normal" },
									{ value: 1.15, label: "Faster" },
									{ value: 1.3, label: "Fastest" },
								]}
								value={settings.voice.ttsSpeed}
								onchange={(ttsSpeed) => saveVoice({ ttsSpeed })}
							/>
						</div>
						<div class="row">
							<div class="label"><span class="title">Quality</span><span class="desc">Higher is clearer and takes a little longer to start.</span></div>
							<Select
								label="Quality"
								options={[
									{ value: 5, label: "Fast" },
									{ value: 8, label: "Balanced" },
									{ value: 12, label: "Best" },
								]}
								value={settings.voice.ttsSteps}
								onchange={(ttsSteps) => saveVoice({ ttsSteps })}
							/>
						</div>
					{/if}
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
						<div class="label"><span class="title">About me</span><span class="desc">What Winku should know about you, in your words. Winku only reads it.</span></div>
						<button type="button" class="btn" onclick={() => shell.openDataPath("about_me")}>Open in editor</button>
					</div>
					<div class="row">
						<div class="label">
							<span class="title">Bring up related notes</span>
							<span class="desc">Before each message, Winku looks through its notes and brings along the ones that relate.</span>
						</div>
						<Switch label="Bring up related notes" checked={settings.memory.recall} onchange={(v) => saveMemory({ recall: v })} />
					</div>
					{#if settings.memory.recall && memoryModel}
						<div class="row">
							<div class="label"><span class="title">Search model</span><span class="desc">{modelLine(memoryModel)}</span></div>
							{#if memoryDownload === null}
								{#if memoryModel.installed}
									<button type="button" class="btn" onclick={removeMemoryModel}>Remove</button>
								{:else}
									<button type="button" class="btn" onclick={downloadMemoryModel}>Download</button>
								{/if}
							{/if}
						</div>
					{/if}
					<div class="row">
						<div class="label"><span class="title">Keep memory up to date</span><span class="desc">{tidyLine()}</span></div>
						<div class="inline end">
							{#if settings.memory.tidy}
								<button type="button" class="btn" disabled={tidying || !memory} onclick={tidyNow}>Tidy now</button>
							{/if}
							<Switch label="Keep memory up to date" checked={settings.memory.tidy} onchange={(v) => saveMemory({ tidy: v })} />
						</div>
					</div>
				</div>
				{#if memoryError}
					<p class="message bad" role="alert">{memoryError}</p>
				{/if}
				{#if memory}
					<h3>Always known</h3>
					<div class="group">
						<div class="row stack">
							<div class="label"><span class="title">Profile</span><span class="desc">Lasting facts about you, one per line.</span></div>
							<textarea
								rows="3"
								aria-label="Profile"
								spellcheck="false"
								placeholder="Nothing yet. Winku adds facts as you talk, or write your own."
								value={cores.profile}
								onfocus={() => (editingCore = "profile")}
								onblur={() => flushCore("profile")}
								oninput={(e) => editCore("profile", e.currentTarget.value)}
							></textarea>
						</div>
						<div class="row stack">
							<div class="label"><span class="title">Goals</span><span class="desc">What you're working toward right now.</span></div>
							<textarea
								rows="2"
								aria-label="Goals"
								spellcheck="false"
								placeholder="Nothing yet."
								value={cores.goals}
								onfocus={() => (editingCore = "goals")}
								onblur={() => flushCore("goals")}
								oninput={(e) => editCore("goals", e.currentTarget.value)}
							></textarea>
						</div>
						<div class="row stack">
							<div class="label"><span class="title">Recap</span><span class="desc">Where your last conversation left off.</span></div>
							<textarea
								rows="2"
								aria-label="Recap"
								placeholder="Nothing yet."
								value={cores.recap}
								onfocus={() => (editingCore = "recap")}
								onblur={() => flushCore("recap")}
								oninput={(e) => editCore("recap", e.currentTarget.value)}
							></textarea>
						</div>
					</div>
					<div class="section-head">
						<h3>Notes{memory.notes.length ? ` (${memory.notes.length})` : ""}</h3>
						{#if memory.notes.length > 0}
							<div class="views" role="group" aria-label="Show notes as">
								<button type="button" aria-pressed={notesView === "list"} onclick={() => showNotesAs("list")}>List</button>
								<button type="button" aria-pressed={notesView === "map"} onclick={() => showNotesAs("map")}>Map</button>
							</div>
						{/if}
					</div>
					{#if memory.notes.length === 0}
						<p class="empty">No notes yet. Winku saves one when you tell it something worth keeping, and when it tidies.</p>
					{:else if notesView === "map"}
						<div class="group">
							<MemoryMap bind:this={map} bind:picked notes={memory.notes} links={memoryLinks} />
							<div class="row foot">
								<p class="status">
									{memory.indexed.embedded === 0
										? "Each note joins its topic. With the search model, dotted lines also join related notes across topics."
										: "Dotted lines join related notes across topics. Scroll to zoom, drag to move."}
								</p>
								<button type="button" class="btn ghost" onclick={() => map?.fit()}>Fit</button>
							</div>
							{#if picked?.note}
								{@const note = picked.note}
								<div class="row note">
									<div class="label">
										<span class="title">{note.title}</span>
										<span class="desc meta">{note.topic} · {noteDay(note.date)}{note.important ? " · important" : ""}</span>
										{#if note.preview && note.preview !== note.title}
											<span class="desc preview">{note.preview}</span>
										{/if}
										{#if picked.related.length}
											<span class="desc related">
												Related:
												{#each picked.related as other, i (other.key)}<button type="button" class="link" onclick={() => map?.select(other.key)}>{other.label}</button>{i < picked.related.length - 1 ? ", " : ""}{/each}
											</span>
										{/if}
									</div>
									<button type="button" class="btn ghost" aria-label="Delete {note.title}" onclick={() => deleteNote(note.topic, note.id)}>Delete</button>
								</div>
							{:else if picked}
								<div class="row note">
									<div class="label">
										<span class="title">{picked.label}</span>
										<span class="desc meta">{picked.size === 1 ? "1 note" : `${picked.size} notes`}</span>
									</div>
								</div>
							{/if}
						</div>
					{:else}
						<div class="group">
							{#each notesShown as note (note.topic + note.id)}
								<div class="row note">
									<div class="label">
										<span class="title">{note.title}</span>
										<span class="desc meta">{note.topic} · {noteDay(note.date)}{note.important ? " · important" : ""}</span>
										{#if note.preview && note.preview !== note.title}
											<span class="desc preview">{note.preview}</span>
										{/if}
									</div>
									<button type="button" class="btn ghost" aria-label="Delete {note.title}" onclick={() => deleteNote(note.topic, note.id)}>Delete</button>
								</div>
							{/each}
							{#if memory.notes.length > NOTES_SHOWN}
								<div class="row foot">
									<p class="status">{allNotes ? `All ${memory.notes.length} notes` : `${NOTES_SHOWN} of ${memory.notes.length}, newest first`}</p>
									<button type="button" class="btn ghost" onclick={() => (allNotes = !allNotes)}>{allNotes ? "Show fewer" : "Show all"}</button>
								</div>
							{/if}
						</div>
					{/if}
					<h3>Try a message</h3>
					<div class="group">
						<form class="row try" onsubmit={(e) => (e.preventDefault(), previewMessage())}>
							<input aria-label="Message to try" placeholder="Type something you might ask, like: what should I cook tonight?" spellcheck="false" bind:value={tryText} />
							<button type="submit" class="btn" disabled={!tryText.trim() || previewing}>See what's added</button>
						</form>
						{#if preview}
							{@const trace = preview.trace}
							{@const left = trace.considered.filter((c) => c.reason)}
							<div class="row">
								<p class="status">{previewLine(preview)}</p>
							</div>
							<div class="row stack">
								<div class="label">
									<span class="title">Added to the message</span>
									<span class="desc">{trace.sent.length ? `${trace.sent.length === 1 ? "1 note" : `${trace.sent.length} notes`}, ${preview.recalled.length.toLocaleString()} characters after your text.` : preview.recallOn ? "No note was close enough, so nothing is added." : "Nothing: bringing up related notes is off."}</span>
								</div>
								{#if trace.sent.length}
									<ul class="hits">
										{#each trace.considered.filter((c) => !c.reason) as hit (hit.id)}
											<li>
												<span class="hit-title">{hit.title}</span>
												<span class="hit-meta">{hit.topic}{hitMeta(hit)}</span>
											</li>
										{/each}
									</ul>
								{/if}
							</div>
							{#if left.length}
								<div class="row stack">
									<div class="label"><span class="title">Close, but left out</span></div>
									<ul class="hits">
										{#each left as hit (hit.id)}
											<li>
												<span class="hit-title">{hit.title}</span>
												<span class="hit-meta">{hit.topic}{hitMeta(hit)} · {hit.reason}</span>
											</li>
										{/each}
									</ul>
								</div>
							{/if}
							<div class="row stack">
								<div class="label">
									<span class="title">Always in the prompt</span>
									<span class="desc">{preview.stale ? "New conversations start with this. The current one started with an older copy, and keeps it until you clear it." : "Every conversation starts with this in its instructions."} {preview.block.length.toLocaleString()} characters.</span>
								</div>
								<pre class="sent">{preview.block}</pre>
							</div>
							{#if preview.recalled}
								<div class="row stack">
									<div class="label"><span class="title">Added after your text, exactly</span></div>
									<pre class="sent">{preview.recalled.trim()}</pre>
								</div>
							{/if}
						{/if}
					</div>
				{/if}
				<div class="group spaced">
					<div class="row">
						<div class="label"><span class="title">Memory files</span><span class="desc">{forgetResult ?? "Plain markdown. Edit them in any editor; Winku picks up the changes."}</span></div>
						<div class="inline end">
							<button type="button" class="btn" onclick={() => shell.openDataPath("memory")}>Open folder</button>
							{#if !confirmForget}
								<button type="button" class="btn" onclick={() => ((confirmForget = true), (forgetResult = null))}>Forget everything</button>
							{/if}
						</div>
					</div>
					{#if confirmForget}
						<div class="row confirm">
							<div class="label"><span class="title bad">Forget everything?</span><span class="desc">This deletes everything Winku remembers: profile, goals, recap and notes. About me and your voice stay.</span></div>
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
							<Select label="Default voice profile" options={profileOptions} value={settings.voiceProfiles.default} onchange={(name) => setVoice({ default: name })} />
							<button type="button" class="btn" onclick={() => shell.openDataPath("voice")}>Open folder</button>
						</div>
					</div>
					{#each Object.entries(settings.voiceProfiles.byApp) as [app, profile] (app)}
						<div class="row">
							<div class="label"><span class="title mono app">{app}</span></div>
							<div class="inline">
								<Select label="Voice profile for {app}" options={profileOptions} value={profile} onchange={(name) => setAppProfile(app, name)} />
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
				<div class="group actions">
					{#each settings.actions as action, i (i)}
						{@const key = settings.hotkeys.actions[i] || "No key"}
						<div class="action">
							<div class="action-main">
								<span class="mono key" title="Action {i + 1}">{key}</span>
								<input
									class="name"
									aria-label="Action {i + 1} name"
									value={action.name}
									oninput={(e) => setAction(i, { name: e.currentTarget.value }, 400)}
								/>
								<Select class="output" label="Action {i + 1} result" options={OUTPUTS} value={action.output} onchange={(output) => setAction(i, { output })} />
								<div class="action-toggles">
									{#if action.output !== "agent"}
										<span class="toggle" title="Use the conversation as context">
											<Switch label="Action {i + 1}: use the conversation as context" checked={action.useThreadContext} onchange={(v) => setAction(i, { useThreadContext: v })} />
											<span class="long">Use the conversation as context</span><span class="brief">Context</span>
										</span>
									{/if}
									<span class="toggle" title="Write in your voice">
										<Switch label="Action {i + 1}: write in your voice" checked={action.useVoice} onchange={(v) => setAction(i, { useVoice: v })} />
										<span class="long">Write in your voice</span><span class="brief">My voice</span>
									</span>
								</div>
							</div>
							<div class="action-prompt">
								<textarea
									rows="1"
									aria-label="Action {i + 1} prompt"
									value={action.prompt}
									oninput={(e) => setAction(i, { prompt: e.currentTarget.value }, 500)}
								></textarea>
								{#if DEFAULT_ACTIONS[i] && !isDefault(action, i)}
									<button type="button" class="btn ghost" title="Reset to default" onclick={() => setAction(i, structuredClone(DEFAULT_ACTIONS[i] as ActionSpec))}>Reset</button>
								{/if}
							</div>
						</div>
					{/each}
				</div>
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
						<Select
							label="Size"
							options={[
								{ value: "small", label: "Small" },
								{ value: "medium", label: "Medium" },
								{ value: "large", label: "Large" },
							] satisfies SelectOption<Settings["eyes"]["size"]>[]}
							value={settings.eyes.size}
							onchange={(size) => save({ eyes: { ...settings!.eyes, size } })}
						/>
					</div>
					<div class="row">
						<div class="label"><span class="title">Hide the eyes</span><span class="desc">A tray icon appears while they're hidden.</span></div>
						<Switch label="Hide the eyes" checked={settings.eyes.hidden} onchange={(v) => save({ eyes: { ...settings!.eyes, hidden: v } })} />
					</div>
				</div>
			{:else if page === "schedules"}
				{#if tasks.length === 0}
					<p class="empty">Nothing scheduled. Ask Winku to remind you, check something every few minutes, or tell you when something happens.</p>
				{:else}
					<div class="group">
						{#each tasks as task (task.id)}
							<div class="row">
								<div class="label">
									<span class="title">{task.name}</span>
									<span class="desc">{taskLine(task)}</span>
								</div>
								<button type="button" class="btn" onclick={() => shell.taskCancel(task.id)}>Cancel</button>
							</div>
						{/each}
					</div>
				{/if}
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
							<Select
								label="Updates"
								options={[
									{ value: "auto", label: "Install automatically" },
									{ value: "notify", label: "Tell me, don't download" },
									{ value: "off", label: "Off" },
								] satisfies SelectOption<Settings["updates"]>[]}
								value={settings.updates}
								onchange={(updates) => save({ updates })}
							/>
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
	.empty {
		color: var(--muted);
		font-size: 13px;
		line-height: 1.5;
		max-width: 52ch;
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
	.group.spaced {
		margin-top: 24px;
	}
	.note .label {
		gap: 3px;
	}
	.note .title {
		overflow-wrap: anywhere;
	}
	.note .meta {
		font-size: 11px;
	}
	.note .preview {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.row.try > input {
		flex: 1 1 auto;
	}
	.hits {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.hits li {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.hit-title {
		font-size: 13px;
		overflow-wrap: anywhere;
	}
	.hit-meta {
		color: var(--muted);
		font-size: 11px;
		text-wrap: pretty;
	}
	pre.sent {
		margin: 0;
		max-height: 220px;
		overflow: auto;
		color: var(--muted);
		font-family: var(--mono);
		font-size: 11.5px;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.section-head {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 12px;
	}
	.views {
		display: inline-flex;
		margin: 0 0 6px;
		padding: 2px;
		border: 1px solid var(--line);
		border-radius: 8px;
	}
	.views button {
		height: 24px;
		padding: 0 10px;
		border: 0;
		border-radius: 6px;
		background: none;
		color: var(--muted);
		font-size: 12px;
		cursor: pointer;
	}
	.views button:hover {
		color: var(--text);
	}
	.views button[aria-pressed="true"] {
		background: var(--panel-raised);
		color: var(--text);
	}
	.views button:focus-visible,
	.link:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 1px;
	}
	.related {
		text-wrap: pretty;
	}
	.link {
		padding: 0;
		border: 0;
		border-radius: 2px;
		background: none;
		color: var(--accent);
		font: inherit;
		cursor: pointer;
	}
	.link:hover {
		text-decoration: underline;
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
	.inline > :global(.select),
	.inline > :global(.combo) {
		flex: 1 1 auto;
	}
	.inline.end {
		justify-content: flex-end;
	}

	/* ── controls ── */
	input:not([type="checkbox"]),
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
	textarea {
		height: auto;
		padding: 8px 10px;
		line-height: 1.5;
		resize: vertical;
		field-sizing: content;
		min-height: 60px;
	}
	input:hover,
	textarea:hover {
		border-color: rgb(255 255 255 / 0.32);
	}
	/* The border is the focus mark; an outline as well would double it. */
	input:focus,
	textarea:focus {
		border-color: var(--focus);
	}
	input:focus-visible,
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
	.inline > :global(.select.level) {
		flex: 0 0 112px;
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
	/* One list. Each action is a line of controls and its prompt: stacked in a narrow window, side
	   by side in a wide one, so nothing stretches across the page. */
	.actions {
		container-type: inline-size;
	}
	.action {
		display: grid;
		gap: 6px;
		padding: 9px 14px;
	}
	.action + .action {
		border-top: 1px solid var(--line);
	}
	.action-main {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.action :is(input, :global(.select .trigger)) {
		height: 28px;
	}
	.key {
		flex: none;
		min-width: 68px;
		color: var(--muted);
	}
	.name {
		flex: 0 1 200px;
	}
	.action-main > :global(.select.output) {
		flex: 0 0 128px;
	}
	.action-toggles {
		flex: none;
		display: flex;
		align-items: center;
		gap: 14px;
		/* Against the right edge and as wide as two switches, so every row's fields line up even
		   when an action has only one. */
		justify-content: flex-end;
		min-width: 212px;
		margin-left: auto;
	}
	.long {
		display: none;
	}
	.action-prompt {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		min-width: 0;
	}
	.action-prompt textarea {
		flex: 1 1 auto;
		min-height: 28px;
		padding: 4px 10px;
		font-size: 12.5px;
		line-height: 1.45;
		resize: none;
	}
	.action-prompt .btn {
		height: 28px;
	}
	/* Too narrow for one line: the switches drop under the name. */
	@container (max-width: 540px) {
		.action-main {
			flex-wrap: wrap;
		}
		.name {
			flex: 1 1 110px;
		}
		.action-toggles {
			flex: 0 0 100%;
			justify-content: flex-start;
			min-width: 0;
			margin-left: 76px;
		}
	}
	@container (min-width: 880px) {
		.action {
			grid-template-columns: 420px minmax(0, 1fr);
			gap: 16px;
			align-items: start;
		}
		.action-main {
			flex-wrap: wrap;
		}
		.name {
			flex: 1 1 110px;
		}
		/* Under the name, clear of the key. */
		.action-toggles {
			flex: 0 0 100%;
			justify-content: flex-start;
			min-width: 0;
			margin-left: 76px;
			gap: 18px;
		}
		.long {
			display: inline;
		}
		.brief {
			display: none;
		}
	}
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		white-space: nowrap;
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
