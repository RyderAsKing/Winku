// Voice profiles (SPEC §9): voice\<name>.md, chosen per app by the shell. The assistant can only
// propose changes (voice_propose); the user Accepts or Dismisses them.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { VoiceProfileInfo } from "./protocol.ts";
import { EngineError } from "./runtime.ts";

/** A profile name is a plain file stem: letters, digits, space, "-" and "_". */
export function profileName(name: string): string {
	const stem = name.trim().replace(/\.md$/i, "");
	if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(stem)) throw new EngineError(`Invalid voice profile name "${name}"`, "engine");
	return stem;
}

export function profileSummary(content: string): string {
	const line = content.split("\n").find((l) => l.trim()) ?? "";
	return line.replace(/^\s*#+\s*/, "").trim();
}

export interface VoiceProposal {
	proposalId: string;
	profile: string;
	content: string;
	current: string;
	reason: string;
}

export class VoiceProfiles {
	readonly dir: string;
	private pending = new Map<string, VoiceProposal>();

	constructor(dataDir: string) {
		this.dir = join(dataDir, "voice");
	}

	private stems(): string[] {
		try {
			return readdirSync(this.dir)
				.filter((f) => f.toLowerCase().endsWith(".md"))
				.map((f) => f.slice(0, -3))
				.sort((a, b) => a.localeCompare(b));
		} catch {
			return [];
		}
	}

	/** Contents of voice\<name>.md, or undefined when the name is invalid or the file is missing. */
	read(name: string): string | undefined {
		try {
			return readFileSync(join(this.dir, `${profileName(name)}.md`), "utf8");
		} catch {
			return undefined;
		}
	}

	all(): { name: string; content: string }[] {
		return this.stems().flatMap((name) => {
			const content = this.read(name);
			return content === undefined ? [] : [{ name, content }];
		});
	}

	list(): VoiceProfileInfo[] {
		return this.all().map(({ name, content }) => ({ name, summary: profileSummary(content) }));
	}

	propose(input: { profile: string; content: string; reason: string }): VoiceProposal {
		const profile = profileName(input.profile);
		if (!input.content.trim()) throw new EngineError("A voice profile proposal needs content", "engine");
		const proposal: VoiceProposal = {
			proposalId: randomUUID(),
			profile,
			content: input.content,
			current: this.read(profile) ?? "",
			reason: input.reason,
		};
		this.pending.set(proposal.proposalId, proposal);
		return proposal;
	}

	/** Accept writes the file; Dismiss (or an unknown proposal) writes nothing. */
	decide(proposalId: string, accept: boolean): { written: boolean } {
		const proposal = this.pending.get(proposalId);
		this.pending.delete(proposalId);
		if (!proposal || !accept) return { written: false };
		mkdirSync(this.dir, { recursive: true });
		const content = proposal.content.endsWith("\n") ? proposal.content : `${proposal.content}\n`;
		writeFileSync(join(this.dir, `${proposal.profile}.md`), content);
		return { written: true };
	}

	dropPending(): void {
		this.pending.clear();
	}
}

export function voiceTools(voice: () => VoiceProfiles, onProposal: (proposal: VoiceProposal) => void) {
	return [
		defineTool({
			name: "voice_propose",
			label: "Propose a voice profile change",
			description:
				"Propose a new version of one of the user's voice profiles (the rules and samples you follow when writing as the user). " +
				"You cannot change a profile yourself: the user sees your proposal and chooses Accept or Dismiss. " +
				"Use it when the user asks to change how they sound, or clearly corrects the way you write for them. " +
				"Send the complete new file, not a diff. Never say the profile was changed; say you proposed it.",
			parameters: Type.Object({
				profile: Type.String({ description: 'Profile name, e.g. "casual" or "work" (a new name creates a profile if accepted)' }),
				content: Type.String({ description: "The full proposed markdown for voice/<profile>.md" }),
				reason: Type.String({ description: "One sentence for the user on why" }),
			}),
			async execute(_id, params) {
				const proposal = voice().propose(params);
				onProposal(proposal);
				return {
					content: [
						{
							type: "text",
							text: `Proposed a change to the "${proposal.profile}" voice profile. The user will Accept or Dismiss it; it is not changed yet.`,
						},
					],
					details: { proposalId: proposal.proposalId, profile: proposal.profile },
				};
			},
		}),
	];
}
