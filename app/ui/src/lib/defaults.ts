// Default settings for the browser mock and "Reset to default" in Settings. The shell
// (settings.rs) owns the real defaults; a Rust test checks the default actions match.
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
			{
				name: "Rewrite",
				prompt:
					"Rewrite the selected text so it reads clearly and naturally. Keep the meaning, language and roughly the same length. Reply with the rewritten text only.",
				output: "replace",
				useThreadContext: false,
				useVoice: true,
			},
			{
				name: "Fix grammar",
				prompt: "Fix spelling, grammar and punctuation in the selected text. Change nothing else. Reply with the corrected text only.",
				output: "replace",
				useThreadContext: false,
				useVoice: false,
			},
			{
				name: "Shorter",
				prompt: "Make the selected text noticeably shorter without losing anything important. Keep the tone. Reply with the shortened text only.",
				output: "replace",
				useThreadContext: false,
				useVoice: true,
			},
			{
				name: "Explain",
				prompt: "Explain the selected text in plain words. Be brief; use a short list only if it helps.",
				output: "show",
				useThreadContext: false,
				useVoice: false,
			},
			{
				name: "Do it",
				prompt: "The selected text is a task or instruction. Carry it out with your tools, then say briefly what you did.",
				output: "agent",
				useThreadContext: true,
				useVoice: false,
			},
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
		guideFollowsSelection: true,
		eyes: { hidden: false, size: "small", positions: {} },
		voice: { stt: "moonshine-base", tts: "supertonic", ttsVoice: 5, osVoice: null, reply: "mirror", say: "enough", listeningPaused: false },
		updates: "auto",
		launchAtLogin: true,
	};
}
