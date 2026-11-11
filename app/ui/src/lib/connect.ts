// Shared logic for picking a provider, key and model (Connect form and Settings).
import type { CustomModel, ModelInfo, ProviderConfig, ProviderInfo } from "../../../../engine/src/protocol.ts";
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
