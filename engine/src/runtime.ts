// Model runtime: pi's bundled catalog or one custom OpenAI-compatible endpoint, keys in memory only.
import {
	type Api,
	type AssistantMessage,
	getSupportedThinkingLevels,
	InMemoryCredentialStore,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFauxProvider, FAUX_PROVIDER, type FauxOptions } from "./faux.ts";
import type { CustomModel, ErrorKind, ModelInfo, ProviderConfig, ProviderInfo, ThinkingLevel } from "./protocol.ts";

/** Provider id used for the custom OpenAI-compatible endpoint. */
export const CUSTOM_PROVIDER = "custom";

export class EngineError extends Error {
	constructor(
		message: string,
		readonly kind: ErrorKind,
	) {
		super(message);
	}
}

const KEY_URLS: Record<string, string> = {
	anthropic: "https://console.anthropic.com/settings/keys",
	openai: "https://platform.openai.com/api-keys",
	openrouter: "https://openrouter.ai/keys",
	google: "https://aistudio.google.com/apikey",
	groq: "https://console.groq.com/keys",
	mistral: "https://console.mistral.ai/api-keys",
	xai: "https://console.x.ai",
	deepseek: "https://platform.deepseek.com/api_keys",
	cerebras: "https://cloud.cerebras.ai",
	fireworks: "https://fireworks.ai/account/api-keys",
	together: "https://api.together.ai/settings/api-keys",
};

/** Map a provider/transport failure message to an ErrorKind. */
export function classifyError(message: string): ErrorKind {
	const m = message.toLowerCase();
	if (/\b(401|403)\b|unauthori[sz]ed|forbidden|api key|apikey|authentication|invalid.*key|permission denied|no credentials/.test(m))
		return "auth";
	if (
		/fetch failed|econnrefused|econnreset|enotfound|etimedout|network|socket|unable to connect|connection (refused|reset|error)|timed? ?out|getaddrinfo|dns/.test(
			m,
		)
	)
		return "network";
	return "model";
}

export function errorOf(error: unknown): EngineError {
	if (error instanceof EngineError) return error;
	const message = error instanceof Error ? error.message : String(error);
	return new EngineError(message, classifyError(message));
}

export function providerId(provider: ProviderConfig): string {
	return provider.kind === "catalog" ? provider.id : CUSTOM_PROVIDER;
}

function customModelConfig(model: CustomModel) {
	return {
		id: model.id,
		name: model.id,
		input: (model.supportsImages ? ["text", "image"] : ["text"]) as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: model.contextWindow,
		maxTokens: Math.min(8192, Math.max(256, Math.floor(model.contextWindow / 4))),
	};
}

export const DEFAULT_CUSTOM_CONTEXT_WINDOW = 32_768;

export interface RuntimeOptions {
	provider: ProviderConfig;
	apiKey?: string;
	/** Model ids that must exist even if a custom provider's list doesn't name them (typed ids). */
	modelIds?: string[];
	faux?: FauxOptions;
}

/** A fresh, isolated ModelRuntime: no auth.json, no models.json, no network catalog refresh. */
export async function createRuntime(options: RuntimeOptions): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const { provider, apiKey } = options;
	if (provider.kind === "catalog" && provider.id === FAUX_PROVIDER) {
		const ids = [...new Set([...(options.modelIds ?? []), "faux-1"])];
		runtime.registerNativeProvider(createFauxProvider(ids, options.faux));
		return runtime;
	}
	if (provider.kind === "custom") {
		const models = [...provider.models];
		for (const id of options.modelIds ?? []) {
			if (!models.some((m) => m.id === id))
				models.push({ id, supportsImages: false, contextWindow: DEFAULT_CUSTOM_CONTEXT_WINDOW });
		}
		runtime.registerProvider(CUSTOM_PROVIDER, {
			name: "Custom",
			baseUrl: provider.baseUrl.replace(/\/+$/, ""),
			api: "openai-completions",
			authHeader: true,
			models: models.map(customModelConfig),
		});
		// Local servers usually take no key, but the provider still needs one to count as configured.
		await runtime.setRuntimeApiKey(CUSTOM_PROVIDER, apiKey || "none");
		return runtime;
	}
	if (!runtime.getProvider(provider.id)) throw new EngineError(`Unknown provider "${provider.id}"`, "config");
	if (apiKey) await runtime.setRuntimeApiKey(provider.id, apiKey);
	return runtime;
}

export function resolveModel(runtime: ModelRuntime, provider: ProviderConfig, modelId: string): Model<Api> {
	const model = runtime.getModel(providerId(provider), modelId);
	if (!model) throw new EngineError(`Unknown model "${modelId}" for provider "${providerId(provider)}"`, "config");
	return model;
}

export function thinkingLevels(model: Model<Api>): ThinkingLevel[] {
	const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
	return levels.includes("off") ? levels : ["off", ...levels];
}

export function clampThinking(model: Model<Api>, level: ThinkingLevel): ThinkingLevel {
	const levels = thinkingLevels(model);
	if (levels.includes(level)) return level;
	const order: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	const wanted = order.indexOf(level);
	return levels.reduce((best, l) => (Math.abs(order.indexOf(l) - wanted) < Math.abs(order.indexOf(best) - wanted) ? l : best));
}

export function modelInfo(model: Model<Api>): ModelInfo {
	return {
		id: model.id,
		name: model.name || model.id,
		supportsImages: model.input.includes("image"),
		contextWindow: model.contextWindow,
		thinkingLevels: thinkingLevels(model),
	};
}

export async function listProviders(): Promise<ProviderInfo[]> {
	const runtime = await createRuntime({ provider: { kind: "catalog", id: "anthropic" } });
	return runtime
		.getProviders()
		.filter((p) => p.id !== FAUX_PROVIDER && runtime.getModels(p.id).length > 0)
		.map((p) => ({ id: p.id, name: p.name, ...(KEY_URLS[p.id] ? { keyUrl: KEY_URLS[p.id] } : {}) }));
}

function numberField(record: Record<string, unknown>, names: string[]): number | undefined {
	for (const name of names) {
		const value = record[name];
		if (typeof value === "number" && value > 0) return value;
	}
	return undefined;
}

export async function listModels(provider: ProviderConfig, apiKey?: string): Promise<ModelInfo[]> {
	if (provider.kind === "catalog") {
		const runtime = await createRuntime({ provider });
		return runtime.getModels(provider.id).map(modelInfo);
	}
	const url = `${provider.baseUrl.replace(/\/+$/, "")}/models`;
	let response: Response;
	try {
		response = await fetch(url, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
			signal: AbortSignal.timeout(15_000),
		});
	} catch (error) {
		throw new EngineError(`Could not reach ${url}: ${errorOf(error).message}`, "network");
	}
	if (!response.ok) {
		const kind: ErrorKind = response.status === 401 || response.status === 403 ? "auth" : "network";
		throw new EngineError(`GET ${url} returned ${response.status}`, kind);
	}
	const body = (await response.json().catch(() => null)) as { data?: unknown; models?: unknown } | null;
	const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : [];
	const known = new Map(provider.models.map((m) => [m.id, m]));
	return (list as Record<string, unknown>[])
		.filter((item) => item && typeof item.id === "string")
		.map((item) => {
			const id = item.id as string;
			const saved = known.get(id);
			return {
				id,
				name: typeof item.name === "string" ? item.name : id,
				supportsImages: saved?.supportsImages ?? false,
				contextWindow:
					saved?.contextWindow ??
					numberField(item, ["context_length", "context_window", "max_model_len", "max_context_length"]) ??
					DEFAULT_CUSTOM_CONTEXT_WINDOW,
				thinkingLevels: ["off"],
			};
		});
}

/** 1×1 transparent PNG. */
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function tinyRequest(runtime: ModelRuntime, model: Model<Api>, withImage: boolean): Promise<AssistantMessage> {
	const message: UserMessage = {
		role: "user",
		content: withImage
			? [
					{ type: "text", text: "What colour is this image? Answer in one word." },
					{ type: "image", data: TINY_PNG, mimeType: "image/png" },
				]
			: "Reply with the word ok.",
		timestamp: Date.now(),
	};
	return runtime.completeSimple(model, { messages: [message] }, { maxTokens: 16, signal: AbortSignal.timeout(30_000) });
}

export interface TestConnectionResult {
	ok: boolean;
	supportsImages: boolean;
	error?: string;
	errorKind?: ErrorKind;
}

export async function testConnection(
	provider: ProviderConfig,
	apiKey: string | undefined,
	modelId: string,
	faux?: FauxOptions,
): Promise<TestConnectionResult> {
	try {
		const runtime = await createRuntime({ provider, apiKey, modelIds: [modelId], faux });
		// Probe the model as text-only first, then with an image.
		const model = resolveModel(runtime, provider, modelId);
		const textOnly = provider.kind === "custom" ? { ...model, input: ["text" as const] } : model;
		const reply = await tinyRequest(runtime, textOnly, false);
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			const message = reply.errorMessage ?? "The model returned an error";
			return { ok: false, supportsImages: false, error: message, errorKind: classifyError(message) };
		}
		if (provider.kind !== "custom") return { ok: true, supportsImages: model.input.includes("image") };
		const withImages = { ...model, input: ["text" as const, "image" as const] };
		const imageReply = await tinyRequest(runtime, withImages, true).catch(() => undefined);
		return { ok: true, supportsImages: !!imageReply && imageReply.stopReason !== "error" && imageReply.stopReason !== "aborted" };
	} catch (error) {
		const e = errorOf(error);
		return { ok: false, supportsImages: false, error: e.message, errorKind: e.kind };
	}
}
