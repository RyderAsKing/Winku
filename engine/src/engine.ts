import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Api, fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { InboundMessage } from "./protocol.ts";

type Configure = Extract<InboundMessage, { type: "configure" }>;

/** Provider id for the scripted test model used by the smoke test. No network, no key. */
export const FAUX_PROVIDER = "winku-faux";

export interface Engine {
	session: AgentSession;
	model: Model<Api>;
	dispose(): void;
}

function isolatedResourceLoader(systemPrompt: string): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

export async function startEngine(config: Configure): Promise<Engine> {
	const engineDir = join(config.dataDir, "engine");
	const sessionDir = join(engineDir, "sessions");
	mkdirSync(sessionDir, { recursive: true });

	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});

	if (config.provider === FAUX_PROVIDER) {
		const faux = fauxProvider({
			provider: FAUX_PROVIDER,
			models: [{ id: config.model, contextWindow: 200_000 }],
			tokensPerSecond: 200,
		});
		faux.setResponses(
			Array.from({ length: 1000 }, () => (context) => {
				const last = context.messages.at(-1);
				const content = last?.content ?? "";
				const text =
					typeof content === "string"
						? content
						: content.map((block) => ("text" in block ? block.text : "")).join("");
				return fauxAssistantMessage(`Hello from winku-engine. You said: ${text}`);
			}),
		);
		modelRuntime.registerNativeProvider(faux.provider);
	} else if (config.apiKey) {
		await modelRuntime.setRuntimeApiKey(config.provider, config.apiKey);
	}

	const model = modelRuntime.getModel(config.provider, config.model);
	if (!model) throw new Error(`Unknown model ${config.provider}/${config.model}`);

	const { session } = await createAgentSession({
		cwd: config.dataDir,
		agentDir: engineDir,
		model,
		thinkingLevel: config.thinkingLevel ?? "medium",
		modelRuntime,
		resourceLoader: isolatedResourceLoader("You are Winku, a small desktop assistant. Be brief."),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } }),
		sessionManager: SessionManager.continueRecent(config.dataDir, sessionDir),
		tools: [],
	});

	return { session, model, dispose: () => session.dispose() };
}
