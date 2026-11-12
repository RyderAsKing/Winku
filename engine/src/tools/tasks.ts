// schedule_task, next_wakeup, watch, list_tasks, cancel_task: thin wrappers over the shell's
// task_* Requests (ARCHITECTURE.md "Scheduled tasks"). The engine turns durations and times
// into milliseconds and words the one-line results; the shell owns the jobs and their rules.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ScheduledRun, TaskInfo, TaskScheduleParams, WatchShell } from "../protocol.ts";
import type { ShellRequests } from "../requests.ts";
import type { ShellChoice } from "./shell.ts";

export const TASK_TIMEOUT_MS = 10_000;

export const ERR_DURATION = "Durations look like 20m, 90s, 2h or 1d.";
export const ERR_TIME = "Times look like 15:30 or 2026-11-14T09:00.";
export const ERR_ONE_OF = "Give exactly one of in, at or every.";
export const ERR_SELF_PACED = "selfPaced needs in, the first delay.";
export const ERR_WAKEUP_ARGS = "Give in, the next delay, or stop: true.";
export const ERR_WAKEUP_PLACE = "next_wakeup only works in a self-paced run.";

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** "20m", "90s", "2h", "1d" (a number and one unit) to milliseconds. */
export function parseDuration(text: string): number {
	const match = /^\s*(\d+(?:\.\d+)?)\s*([smhd])\s*$/i.exec(text);
	const ms = match ? Number(match[1]) * UNIT_MS[(match[2] as string).toLowerCase() as keyof typeof UNIT_MS] : 0;
	if (!(ms > 0) || !Number.isFinite(ms)) throw new Error(ERR_DURATION);
	return Math.round(ms);
}

/**
 * A wall-clock time to epoch ms, in the local time zone: `HH:MM` (today, or tomorrow if it has
 * passed) or an ISO date-time without a zone (`2026-11-14T09:00`, seconds optional).
 */
export function parseAt(text: string, now: Date): number {
	const value = text.trim();
	const clock = /^(\d{1,2}):(\d{2})$/.exec(value);
	if (clock) {
		const [hours, minutes] = [Number(clock[1]), Number(clock[2])];
		if (hours > 23 || minutes > 59) throw new Error(ERR_TIME);
		const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
		if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
		return at.getTime();
	}
	const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
	if (iso) {
		const [year, month, day, hours, minutes, seconds] = [iso[1], iso[2], iso[3], iso[4], iso[5], iso[6] ?? "0"].map(Number) as [number, number, number, number, number, number];
		const at = new Date(year, month - 1, day, hours, minutes, seconds, 0);
		// new Date rolls 2026-02-31 over to March: refuse what it didn't mean.
		if (at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day && hours <= 23 && minutes <= 59 && seconds <= 59)
			return at.getTime();
	}
	throw new Error(ERR_TIME);
}

export interface ScheduleArgs {
	name: string;
	prompt: string;
	in?: string;
	at?: string;
	every?: string;
	selfPaced?: boolean;
}

/** The schedule_task arguments as the shell's task_schedule params (without spoken and from). */
export function resolveSchedule(args: ScheduleArgs, now: Date): Pick<TaskScheduleParams, "name" | "prompt" | "kind" | "at" | "everyMs" | "selfPaced" | "inMs"> {
	const given = [args.in, args.at, args.every].filter((v) => v !== undefined).length;
	if (given !== 1) throw new Error(ERR_ONE_OF);
	const base = { name: args.name, prompt: args.prompt };
	if (args.selfPaced) {
		if (args.in === undefined) throw new Error(ERR_SELF_PACED);
		return { ...base, kind: "loop", selfPaced: true, inMs: parseDuration(args.in) };
	}
	if (args.every !== undefined) return { ...base, kind: "loop", everyMs: parseDuration(args.every) };
	if (args.in !== undefined) return { ...base, kind: "timer", at: now.getTime() + parseDuration(args.in) };
	return { ...base, kind: "timer", at: parseAt(args.at as string, now) };
}

/** Local `HH:MM`. */
export function clockTime(epochMs: number): string {
	const at = new Date(epochMs);
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** Milliseconds as the largest whole unit: 120000 → "2m", 5400000 → "90m". */
export function formatDuration(ms: number): string {
	for (const [unit, size] of [["d", UNIT_MS.d], ["h", UNIT_MS.h], ["m", UNIT_MS.m]] as const) if (ms % size === 0) return `${ms / size}${unit}`;
	return `${Math.round(ms / 1000)}s`;
}

const quote = (name: string) => `"${name}"`;

function scheduledLine(task: TaskInfo): string {
	const head = `Scheduled ${task.id} ${quote(task.name)}`;
	const next = task.nextRunAt !== undefined ? clockTime(task.nextRunAt) : undefined;
	if (task.kind === "timer") return `${head}: once at ${next ?? "?"}.`;
	if (task.selfPaced) return `${head}: self-paced, first run at ${next ?? "?"}.`;
	return `${head}: every ${formatDuration(task.everyMs ?? 0)}, next at ${next ?? "?"}.`;
}

export function listLine(task: TaskInfo): string {
	const kind = task.kind === "loop" ? (task.selfPaced ? "loop self-paced" : `loop every ${formatDuration(task.everyMs ?? 0)}`) : task.kind;
	const next = task.nextRunAt !== undefined ? `next ${clockTime(task.nextRunAt)}` : undefined;
	return [task.id, quote(task.name), kind, ...(next ? [next] : []), `runs ${task.runs}`, task.status].join("  ");
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

export interface TaskToolDeps {
	requests: ShellRequests;
	/** The active reply's scheduled run, if it is one. */
	scheduledRun: () => ScheduledRun | undefined;
	/** The active reply's prompt was dictated. */
	spoken: () => boolean;
	shells: ShellChoice;
	platform?: NodeJS.Platform;
	now?: () => Date;
}

const PROMPT_ADVICE =
	"The prompt must stand on its own: it runs later as a new message, possibly after the thread was cleared, so say what to do and include every detail it needs.";

export function taskTools(deps: TaskToolDeps) {
	const now = deps.now ?? (() => new Date());
	const from = () => deps.scheduledRun()?.jobId;
	/** `from` when this call is made inside a scheduled run. */
	const fromParam = () => {
		const id = from();
		return id ? { from: id } : {};
	};

	const schedule = defineTool({
		name: "schedule_task",
		label: "Schedule a task",
		description:
			"Schedule a prompt to run later as a new message to you. With in or at it runs once (a timer); with every, or selfPaced, it repeats (a loop). " +
			"Give exactly one of in, at or every. in and every are a number plus s, m, h or d (20m, 90s, 2h, 1d; 1h30m is not accepted). " +
			"at is HH:MM (today, or tomorrow if that has passed) or a local date-time like 2026-11-14T09:00. Intervals and delays are at least 15s; a timer is at most 7 days ahead; loops expire after 7 days. " +
			"selfPaced makes a loop whose every run picks the next delay with next_wakeup (1 to 60 minutes) or stops with stop: true; it needs in, the first delay. " +
			`${PROMPT_ADVICE} A loop calls the model on every run, so prefer a timer, or a watch for waiting on something, and give a loop a real reason to repeat. ` +
			"This is not available inside a scheduled run.",
		parameters: Type.Object({
			name: Type.String({ description: "A short name (40 characters at most), shown to the user" }),
			prompt: Type.String({ description: "What to do when it runs, written to stand on its own" }),
			in: Type.Optional(Type.String({ description: 'Run once after this long: "20m"' })),
			at: Type.Optional(Type.String({ description: 'Run once at this time: "15:30" or "2026-11-14T09:00"' })),
			every: Type.Optional(Type.String({ description: 'Repeat at this interval: "5m"' })),
			selfPaced: Type.Optional(Type.Boolean({ description: "Each run chooses the next delay with next_wakeup; in is the first delay" })),
		}),
		async execute(_id, params, signal) {
			const resolved = resolveSchedule(params, now());
			const task = (await deps.requests.request(
				"task_schedule",
				{ ...resolved, spoken: deps.spoken(), ...fromParam() },
				{ timeoutMs: TASK_TIMEOUT_MS, signal },
			)) as TaskInfo;
			return text(scheduledLine(task));
		},
	});

	const wakeup = defineTool({
		name: "next_wakeup",
		label: "Choose the next run",
		description:
			"Only in a self-paced run: set when this task runs next, with in (1m to 60m, like 10m) and a short reason for the user, or end it with stop: true. " +
			"Call it exactly once per run; without it the task falls back to 20 minutes once, then ends. After a run flagged as the final one it is refused.",
		parameters: Type.Object({
			in: Type.Optional(Type.String({ description: 'The delay until the next run: "10m"' })),
			reason: Type.Optional(Type.String({ description: "Why that long; shown to the user" })),
			stop: Type.Optional(Type.Boolean({ description: "End the task: nothing more to do" })),
		}),
		async execute(_id, params, signal) {
			const jobId = from();
			if (!jobId) throw new Error(ERR_WAKEUP_PLACE);
			if (!params.stop && params.in === undefined) throw new Error(ERR_WAKEUP_ARGS);
			const delayMs = params.stop ? undefined : parseDuration(params.in as string);
			const data = (await deps.requests.request(
				"task_wakeup",
				{ from: jobId, ...(delayMs !== undefined ? { delayMs } : { stop: true }), ...(params.reason ? { reason: params.reason } : {}) },
				{ timeoutMs: TASK_TIMEOUT_MS, signal },
			)) as { task?: TaskInfo } | undefined;
			const name = quote(data?.task?.name ?? deps.scheduledRun()?.name ?? "this task");
			if (delayMs === undefined) return text(`Stopped ${name}.`);
			const at = data?.task?.nextRunAt ?? now().getTime() + delayMs;
			return text(`Next run of ${name} at ${clockTime(at)}${params.reason ? ` (${params.reason})` : ""}.`);
		},
	});

	const watch = defineTool({
		name: "watch",
		label: "Watch a command",
		description:
			"Run a command in the background and wake yourself with the lines it prints (the prompt runs with those lines). Use it to wait for something: a build, a deploy, a file, a process, a page. " +
			"Prefer a command that prints only the lines that matter, so you aren't woken for nothing: loop and test inside the command and print when something changes. Each line is one wake-up, so don't print progress. " +
			"The command runs in PowerShell on Windows, otherwise in the same shell as the bash tool, in the user's home folder, with no input. When it exits the watch ends. Watches expire after 7 days. " +
			"Example (PowerShell, checks every 30 s and prints only when the status changes): " +
			"$last = ''; while ($true) { $s = (Invoke-WebRequest -UseBasicParsing https://example.com/status).StatusCode; if ($s -ne $last) { \"status $s\"; $last = $s }; Start-Sleep 30 }. " +
			`${PROMPT_ADVICE} Starting a watch asks the user like running a command does.`,
		parameters: Type.Object({
			description: Type.String({ description: "What is being watched, in a few words (shown to the user)" }),
			command: Type.String({ description: "The command to run; each line it prints wakes you" }),
			prompt: Type.String({ description: "What to do when lines arrive, written to stand on its own" }),
		}),
		async execute(_id, params, signal) {
			const shell = watchShell(deps.shells, deps.platform ?? process.platform);
			const task = (await deps.requests.request(
				"task_schedule",
				{
					name: params.description,
					prompt: params.prompt,
					kind: "watch",
					command: params.command,
					description: params.description,
					shell,
					spoken: deps.spoken(),
					...fromParam(),
				},
				{ timeoutMs: TASK_TIMEOUT_MS, signal },
			)) as TaskInfo;
			return text(`Watching ${task.id} ${quote(task.name)}.`);
		},
	});

	const list = defineTool({
		name: "list_tasks",
		label: "List scheduled tasks",
		description: "List the scheduled tasks and watches: one line each with id, name, kind, next run, runs so far and status.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			const data = (await deps.requests.request("task_list", {}, { timeoutMs: TASK_TIMEOUT_MS, signal })) as { tasks?: TaskInfo[] } | undefined;
			const tasks = data?.tasks ?? [];
			return text(tasks.length ? tasks.map(listLine).join("\n") : "No scheduled tasks.");
		},
	});

	const cancel = defineTool({
		name: "cancel_task",
		label: "Cancel a scheduled task",
		description: "Cancel a scheduled task or watch by its id (list_tasks shows them). A scheduled run can only cancel its own task.",
		parameters: Type.Object({ id: Type.String({ description: "The task's id, like 3f9a2c1d" }) }),
		async execute(_id, params, signal) {
			const task = (await deps.requests.request("task_cancel", { id: params.id.trim(), ...fromParam() }, { timeoutMs: TASK_TIMEOUT_MS, signal })) as TaskInfo | undefined;
			return text(`Cancelled ${quote(task?.name ?? params.id.trim())}.`);
		},
	});

	return [schedule, wakeup, watch, list, cancel];
}

/** PowerShell on Windows, else the bash the bash tool uses. */
export function watchShell(shells: ShellChoice, platform: NodeJS.Platform): WatchShell {
	if (platform === "win32") return { kind: "powershell" };
	if (!shells.bash) throw new Error("There is no shell to run a watch in.");
	return { kind: "bash", path: shells.bash };
}
