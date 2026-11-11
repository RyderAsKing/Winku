// Streaming splitter for <say>…</say>, the part of a spoken reply that is read aloud (SPEC §11).
// Pure, no I/O. Everything inside a say block goes to `said` when the block closes; everything
// outside it is the written reply. Partial tags at a delta boundary are held back until they
// resolve, so tag characters never reach the screen. The written text right after a block has
// its leading whitespace dropped, so it doesn't start with the blank line that followed </say>.

const OPEN = "<say>";
const CLOSE = "</say>";

/** Length of the longest suffix of `text` that is a proper prefix of `tag` (case-insensitive). */
function partialTail(text: string, tag: string): number {
	const lower = text.slice(-(tag.length - 1)).toLowerCase();
	for (let n = Math.min(lower.length, tag.length - 1); n > 0; n--) {
		if (tag.startsWith(lower.slice(-n))) return n;
	}
	return 0;
}

export class SayStripper {
	private pending = "";
	private inSay = false;
	private sayBuffer = "";
	private trimNext = false;
	/** Every block said so far, in order. */
	readonly said: string[] = [];

	/** Feed a raw delta. Returns the written text that is safe to show now, and blocks that closed. */
	push(delta: string): { shown: string; said: string[] } {
		this.pending += delta;
		let shown = "";
		const closed: string[] = [];
		for (;;) {
			const lower = this.pending.toLowerCase();
			if (this.inSay) {
				const end = lower.indexOf(CLOSE);
				if (end < 0) {
					const keep = partialTail(this.pending, CLOSE);
					this.sayBuffer += this.pending.slice(0, this.pending.length - keep);
					this.pending = this.pending.slice(this.pending.length - keep);
					break;
				}
				this.sayBuffer += this.pending.slice(0, end);
				this.pending = this.pending.slice(end + CLOSE.length);
				this.inSay = false;
				this.trimNext = true;
				const text = this.sayBuffer.trim();
				this.sayBuffer = "";
				if (text) {
					closed.push(text);
					this.said.push(text);
				}
				continue;
			}
			const start = lower.indexOf(OPEN);
			const cut = start >= 0 ? start : this.pending.length - partialTail(this.pending, OPEN);
			shown += this.release(this.pending.slice(0, cut));
			if (start < 0) {
				this.pending = this.pending.slice(cut);
				break;
			}
			this.pending = this.pending.slice(start + OPEN.length);
			this.inSay = true;
		}
		return { shown, said: closed };
	}

	/** Stream finished. An unclosed block still counts as said; a dangling partial tag is dropped. */
	finish(): { shown: string; said: string[] } {
		const closed: string[] = [];
		let shown = "";
		if (this.inSay) {
			const text = (this.sayBuffer + this.pending).trim();
			if (text) {
				closed.push(text);
				this.said.push(text);
			}
		} else if (!OPEN.startsWith(this.pending.toLowerCase())) {
			shown = this.release(this.pending);
		}
		this.pending = "";
		this.sayBuffer = "";
		this.inSay = false;
		return { shown, said: closed };
	}

	private release(text: string): string {
		if (!this.trimNext) return text;
		const trimmed = text.replace(/^\s+/, "");
		if (trimmed) this.trimNext = false;
		return trimmed;
	}
}

/** Split a complete text into what is shown and what is said. */
export function splitSay(text: string): { text: string; said: string[] } {
	const stripper = new SayStripper();
	const first = stripper.push(text);
	const last = stripper.finish();
	return { text: first.shown + last.shown, said: stripper.said };
}
