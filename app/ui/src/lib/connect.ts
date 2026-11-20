// Shared logic for picking a provider, key and model (Connect form and Settings).
import type { CustomModel, ExtensionInfo, ModelInfo, ProviderConfig, ProviderInfo } from "../../../../engine/src/protocol.ts";
import { shell } from "./shell.ts";

export const CUSTOM = "__custom__";

export const PRESETS = [
	{ name: "Ollama", baseUrl: "http://localhost:11434/v1" },
	{ name: "LM Studio", baseUrl: "http://localhost:1234/v1" },
];

export const DEFAULT_CUSTOM_CONTEXT = 32_768;

export function providerConfig(providerId: string, baseUrl: string, models: CustomModel[]): ProviderConfig {
	return providerId === CUSTOM ? { kind: "custom", baseUrl: baseUrl.trim().replace(/\/+$/, ""), models } : { kind: "catalog", id: providerId };
}

export async function listProviders(): Promise<ProviderInfo[]> {
	return shell.call<ProviderInfo[]>({ type: "list_providers" });
}

export async function listModels(provider: ProviderConfig, apiKey?: string): Promise<ModelInfo[]> {
	return shell.call<ModelInfo[]>({ type: "list_models", provider, apiKey: apiKey || undefined });
}

export interface TestResult {
	ok: boolean;
	supportsImages: boolean;
	error?: string;
}

export async function testConnection(provider: ProviderConfig, model: string, apiKey?: string): Promise<TestResult> {
	try {
		return await shell.call<TestResult>({ type: "test_connection", provider, model, apiKey: apiKey || undefined });
	} catch (error) {
		return { ok: false, supportsImages: false, error: String(error) };
	}
}

export async function listExtensions(): Promise<ExtensionInfo[]> {
	return shell.call<ExtensionInfo[]>({ type: "extensions_list" });
}

export async function installExtension(source: string): Promise<ExtensionInfo> {
	return shell.call<ExtensionInfo>({ type: "extension_install", source });
}

export async function removeExtension(name: string): Promise<void> {
	await shell.call({ type: "extension_remove", name });
}

/** What the key field says for a provider: extension providers may sign in on their own. */
export function keyPlaceholder(provider: ProviderInfo | undefined, custom: boolean): string {
	if (custom) return "Optional for local servers";
	if (provider?.extension) return "Optional if it signs in on its own";
	return "Paste your key";
}

/** Whether Test can run without a key: custom endpoints and extension providers may not need one. */
export function keyOptional(provider: ProviderInfo | undefined, custom: boolean): boolean {
	return custom || !!provider?.extension;
}

/** Provider picker entries: the catalog, then extension providers, then a custom OpenAI-compatible endpoint. */
export function providerOptions(providers: ProviderInfo[]): { value: string; label: string; hint?: string }[] {
	return [
		...providers.map((p) => ({ value: p.id, label: p.name, ...(p.extension ? { hint: `From ${p.extension}` } : {}) })),
		{ value: CUSTOM, label: "Custom OpenAI-compatible", hint: "Ollama, LM Studio or any /v1 endpoint" },
	];
}

/** Model picker entries: the name, with the id and what the model can do under it. */
export function modelOptions(models: ModelInfo[]): { value: string; label: string; hint: string }[] {
	return models.map((m) => {
		const facts = [m.contextWindow ? `${contextLabel(m.contextWindow)} context` : "", m.supportsImages ? "images" : ""].filter(Boolean);
		const hint = [m.name && m.name !== m.id ? m.id : "", ...facts].filter(Boolean).join(" · ");
		return { value: m.id, label: m.name || m.id, hint };
	});
}

function contextLabel(tokens: number): string {
	if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
	return `${Math.round(tokens / 1000)}k`;
}
