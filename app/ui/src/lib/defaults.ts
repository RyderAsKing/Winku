// Default settings for the browser mock. The shell (settings.rs) owns the real defaults.
import type { Settings } from "./settings.ts";

export function defaultSettings(): Settings {
	return {
		version: 1,
		provider: null,
		main: null,
		quick: null,
		compactionReserveTokens: null,
		askBeforeRunning: false,
		alwaysAllow: [],
		assistantStyle: "",
		voiceProfiles: { default: "casual", byApp: {} },
		actions: [
			{ name: "Rewrite", prompt: "Rewrite this so it reads well. Keep the meaning.", output: "replace", useThreadContext: false, useVoice: true },
			{ name: "Fix grammar", prompt: "Fix spelling and grammar only.", output: "replace", useThreadContext: false, useVoice: false },
			{ name: "Shorter", prompt: "Make this shorter. Keep what matters.", output: "replace", useThreadContext: false, useVoice: true },
			{ name: "Explain", prompt: "Explain this plainly.", output: "show", useThreadContext: false, useVoice: false },
			{ name: "Do it", prompt: "Do what this text asks.", output: "agent", useThreadContext: true, useVoice: false },
		],
		hotkeys: {
			summon: "Ctrl+Alt+Space",
			actions: ["Ctrl+Alt+1", "Ctrl+Alt+2", "Ctrl+Alt+3", "Ctrl+Alt+4", "Ctrl+Alt+5"],
			askSelection: "Ctrl+Alt+Q",
			screenshot: "Ctrl+Alt+S",
			clear: "Ctrl+Alt+X",
			cycleThinking: "Ctrl+Alt+T",
		},
		leaderKey: null,
		eyes: { hidden: false, positions: {} },
		voice: { stt: "moonshine-base", tts: "os", osVoice: null, reply: "mirror", listeningPaused: false },
		updates: "auto",
		launchAtLogin: true,
	};
}
