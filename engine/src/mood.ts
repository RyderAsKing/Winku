// Streaming stripper for the <mood:…> tag the model ends each reply with. Pure, no I/O.
//
// Every complete <mood:word> tag is removed wherever it appears; the last valid one wins.
// A possibly-partial tag at a delta boundary is held back until it resolves, so tag
// characters never reach text_delta. Trailing whitespace is held too, so the visible
// reply never ends with the space that preceded the tag.
import type { Mood } from "./protocol.ts";

export const MOODS: readonly Mood[] = ["happy", "hearts", "neutral", "sad", "surprised", "thinking"];

const TAG = /<mood:([a-z_-]*)>/gi;
/** A suffix that could still grow into a mood tag. */
const PARTIAL = /<(?:m(?:o(?:o(?:d(?::[a-z_-]*)?)?)?)?)?$/i;

function toMood(word: string): Mood | undefined {
	const lower = word.toLowerCase();
	return (MOODS as readonly string[]).includes(lower) ? (lower as Mood) : undefined;
}

export class MoodStripper {
	private pending = "";
	private emitted = "";
	mood: Mood | undefined;

	/** Feed a raw delta; returns the text that is safe to show now (may be ""). */
	push(delta: string): string {
		this.pending += delta;
		this.pending = this.pending.replace(TAG, (_, word: string) => {
			this.mood = toMood(word) ?? this.mood;
			return "";
		});
		let hold = this.pending.length;
		const partial = PARTIAL.exec(this.pending);
		if (partial) hold = partial.index;
		// Hold whitespace right before the held part (or at the very end).
		while (hold > 0 && /\s/.test(this.pending[hold - 1] ?? "")) hold--;
		const out = this.pending.slice(0, hold);
		this.pending = this.pending.slice(hold);
		this.emitted += out;
		return out;
	}

	/** Stream finished. Drops any dangling partial tag and trailing whitespace. */
	finish(): { text: string; mood: Mood | undefined } {
		this.pending = "";
		return { text: this.emitted, mood: this.mood };
	}
}

/** Strip mood tags from a complete text. */
export function stripMood(text: string): { text: string; mood: Mood | undefined } {
	const stripper = new MoodStripper();
	stripper.push(text);
	return stripper.finish();
}
