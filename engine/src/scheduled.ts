// The user message of a scheduled run, and reading it back for the transcript.
//   timer / loop:  "[scheduled: <name>] <prompt>"
//   watch:         "[watch: <description>]\n<line>\n<line>\n\n<prompt>"
// followed by notes in parentheses when they apply, then the now line (nowline.ts).
import type { ScheduledRun, TaskKind } from "./protocol.ts";

const NOTE_FINAL = "(final run: this task expired after 7 days)";
const noteMissed = (n: number) => `(${n} missed runs collapsed into this one)`;
const noteDropped = (n: number) => `(${n} earlier lines dropped)`;

const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ").trim();

/** What the model reads for a scheduled run whose prompt is `text`. */
export function formatScheduled(run: ScheduledRun, text: string): string {
	const body =
		run.kind === "watch"
			? [`[watch: ${oneLine(run.description ?? run.name)}]`, ...(run.lines ?? []).map(oneLine), "", text].join("\n")
			: `[scheduled: ${oneLine(run.name)}] ${text}`;
	const notes = [
		...(run.dropped ? [noteDropped(run.dropped)] : []),
		...(run.missed ? [noteMissed(run.missed)] : []),
		...(run.final ? [NOTE_FINAL] : []),
	];
	return notes.length ? `${body} ${notes.join(" ")}` : body;
}

const TRAILING_NOTES = /((?: \((?:final run: this task expired after 7 days|\d+ missed runs collapsed into this one|\d+ earlier lines dropped)\))+)$/;

/**
 * Undo formatScheduled: the job's prompt and its name and kind. A timer and a loop read the same,
 * so a "[scheduled: …]" message comes back as a timer.
 */
export function parseScheduled(message: string): { text: string; scheduled?: { name: string; kind: TaskKind } } {
	const withoutNotes = message.replace(TRAILING_NOTES, "");
	const watch = /^\[watch: ([^\n]*)\]\n(?:[^\n]+\n)*\n/.exec(withoutNotes);
	if (watch) return { text: withoutNotes.slice(watch[0].length), scheduled: { name: watch[1] as string, kind: "watch" } };
	const timed = /^\[scheduled: ([^\n]*?)\] /.exec(withoutNotes);
	if (timed) return { text: withoutNotes.slice(timed[0].length), scheduled: { name: timed[1] as string, kind: "timer" } };
	return { text: message };
}
