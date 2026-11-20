// Registers one OpenAI-compatible provider that nothing listens on.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.registerProvider("test-ext", {
		name: "Test Extension Provider",
		baseUrl: "http://127.0.0.1:9/v1",
		api: "openai-completions",
		apiKey: "unused",
		models: [
			{
				id: "ext-model",
				name: "Extension Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 64000,
				maxTokens: 4096,
			},
		],
	});
}
