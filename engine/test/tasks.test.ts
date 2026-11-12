// Scheduled tasks (#43), engine side: the tools' Requests and one-line results, the scheduled
// run's user message and its transcript row, notices, and the permission rules.
import { afterAll, afterEach, expect, test } from "bun:test";
import type { FauxStep } from "../src/faux.ts";
import type { OutboundMessage, Request, ScheduledRun, TaskInfo, TranscriptItem } from "../src/protocol.ts";
import { formatScheduled, parseScheduled } from "../src/scheduled.ts";
import { checkPermission, DECLINED, type GateDeps, policyFrom } from "../src/tools/permission.ts";
import {
	clockTime,
	ERR_DURATION,
	ERR_ONE_OF,
	ERR_SELF_PACED,
	ERR_TIME,
	ERR_WAKEUP_ARGS,
	ERR_WAKEUP_PLACE,
	formatDuration,
	listLine,
	parseAt,
	parseDuration,
	resolveSchedule,
	watchShell,
} from "../src/tools/tasks.ts";
import { EngineProcess, removeTempDirs } from "./harness.ts";

const running: EngineProcess[] = [];
function start(): EngineProcess {
	const engine = EngineProcess.start();
	running.push(engine);
	return engine;
}
afterAll(removeTempDirs);
afterEach(() => {
	for (const engine of running.splice(0)) {
		try {
			engine.proc.kill();
		} catch {}
	}
});

const T = 30_000;
const call = (name: string, args: Record<string, unknown> = {}): FauxStep => ({ toolCalls: [{ name, arguments: args }] });
const at = (h: number, m: number) => new Date(2026, 10, 13, h, m).getTime();
const info = (extra: Partial<TaskInfo> = {}): TaskInfo => ({ id: "3f9a2c1d", name: "Oven", kind: "timer", selfPaced: false, runs: 0, status: "scheduled", ...extra });

type TaskRequest = Extract<Request, { method: `task_${string}` }>;
const taskRequests = (engine: EngineProcess) => engine.records.filter((r): r is TaskRequest => r.type === "request" && r.method.startsWith("task_"));
const permissionRequests = (records: OutboundMessage[]) =>
	records.filter((r): r is Extract<Request, { method: "permission" }> => r.type === "request" && r.method === "permission");

type ToolRow = Extract<TranscriptItem, { kind: "tool" }>;
async function transcript(engine: EngineProcess): Promise<TranscriptItem[]> {
	return engine.callOk<TranscriptItem[]>({ type: "transcript" });
}
async function toolRows(engine: EngineProcess): Promise<ToolRow[]> {
	return (await transcript(engine)).filter((t): t is ToolRow => t.kind === "tool");
}

// ───────────────────────────── pure parsing ─────────────────────────────

test("durations are a number and one unit", () => {
	expect(parseDuration("20m")).toBe(1_200_000);
	expect(parseDuration("90s")).toBe(90_000);
	expect(parseDuration("2h")).toBe(7_200_000);
	expect(parseDuration("1d")).toBe(86_400_000);
	expect(parseDuration(" 1.5h ")).toBe(5_400_000);
	expect(parseDuration("5M")).toBe(300_000);
	for (const bad of ["1h30m", "20", "m", "", "0m", "-5m", "soon", "5 minutes"]) expect(() => parseDuration(bad)).toThrow(ERR_DURATION);
});

test("at is HH:MM (today, or tomorrow once past) or a local date-time", () => {
	const now = new Date(2026, 10, 13, 14, 20, 30);
	expect(parseAt("14:40", now)).toBe(at(14, 40));
	expect(parseAt("9:05", now)).toBe(new Date(2026, 10, 14, 9, 5).getTime());
	expect(parseAt("14:20", now)).toBe(new Date(2026, 10, 14, 14, 20).getTime());
	expect(parseAt("2026-11-14T09:00", now)).toBe(new Date(2026, 10, 14, 9, 0).getTime());
	expect(parseAt("2026-11-14T09:00:30", now)).toBe(new Date(2026, 10, 14, 9, 0, 30).getTime());
	for (const bad of ["25:00", "12:60", "noon", "2026-02-31T09:00", "2026-11-14", "14:40 tomorrow", ""]) expect(() => parseAt(bad, now)).toThrow(ERR_TIME);
});

test("schedule_task arguments become a task_schedule's params", () => {
	const now = new Date(2026, 10, 13, 14, 20, 0);
	const base = { name: "Oven", prompt: "Check the oven." };
	expect(resolveSchedule({ ...base, in: "20m" }, now)).toEqual({ ...base, kind: "timer", at: at(14, 40) });
	expect(resolveSchedule({ ...base, at: "16:00" }, now)).toEqual({ ...base, kind: "timer", at: at(16, 0) });
	expect(resolveSchedule({ ...base, every: "2m" }, now)).toEqual({ ...base, kind: "loop", everyMs: 120_000 });
	expect(resolveSchedule({ ...base, in: "10m", selfPaced: true }, now)).toEqual({ ...base, kind: "loop", selfPaced: true, inMs: 600_000 });
	for (const args of [{}, { in: "5m", at: "16:00" }, { in: "5m", every: "5m" }, { at: "16:00", every: "5m" }]) expect(() => resolveSchedule({ ...base, ...args }, now)).toThrow(ERR_ONE_OF);
	expect(() => resolveSchedule({ ...base, every: "5m", selfPaced: true }, now)).toThrow(ERR_SELF_PACED);
	expect(() => resolveSchedule({ ...base, at: "16:00", selfPaced: true }, now)).toThrow(ERR_SELF_PACED);
	expect(() => resolveSchedule({ ...base, in: "soon" }, now)).toThrow(ERR_DURATION);
	expect(() => resolveSchedule({ ...base, at: "soon" }, now)).toThrow(ERR_TIME);
});

test("results are worded as the contract shows", () => {
	expect(clockTime(at(9, 5))).toBe("09:05");
	expect([120_000, 90_000, 3_600_000, 5_400_000, 86_400_000, 15_000].map(formatDuration)).toEqual(["2m", "90s", "1h", "90m", "1d", "15s"]);
	expect(listLine(info({ id: "3f9a2c1d", name: "DM", kind: "loop", everyMs: 120_000, nextRunAt: at(14, 22), runs: 3 }))).toBe('3f9a2c1d  "DM"  loop every 2m  next 14:22  runs 3  scheduled');
	expect(listLine(info({ kind: "loop", selfPaced: true, nextRunAt: at(14, 29), status: "running" }))).toBe('3f9a2c1d  "Oven"  loop self-paced  next 14:29  runs 0  running');
	expect(listLine(info({ kind: "watch", name: "build fails", status: "watching" }))).toBe('3f9a2c1d  "build fails"  watch  runs 0  watching');
});

test("a watch runs in PowerShell on Windows, else in the bash tool's shell", () => {
	expect(watchShell({ powershell: true, bash: "C:\\Git\\bin\\bash.exe" }, "win32")).toEqual({ kind: "powershell" });
	expect(watchShell({ powershell: false, bash: "/bin/bash" }, "linux")).toEqual({ kind: "bash", path: "/bin/bash" });
	expect(() => watchShell({ powershell: false, bash: undefined }, "linux")).toThrow();
});

test("a scheduled run's message reads back as its prompt, name and kind", () => {
	const timer: ScheduledRun = { jobId: "a", name: "Oven", kind: "timer" };
	expect(formatScheduled(timer, "Check the oven.")).toBe("[scheduled: Oven] Check the oven.");
	expect(formatScheduled({ ...timer, kind: "loop", final: true, missed: 3 }, "Check.")).toBe(
		"[scheduled: Oven] Check. (3 missed runs collapsed into this one) (final run: this task expired after 7 days)",
	);
	const watch: ScheduledRun = { jobId: "b", name: "build fails", kind: "watch", description: "build fails", lines: ["FAIL a", "FAIL b"], dropped: 4 };
	expect(formatScheduled(watch, "Tell me.")).toBe("[watch: build fails]\nFAIL a\nFAIL b\n\nTell me. (4 earlier lines dropped)");
	expect(formatScheduled({ ...watch, lines: undefined, dropped: undefined }, "Tell me.")).toBe("[watch: build fails]\n\nTell me.");

	expect(parseScheduled("[scheduled: Oven] Check the oven.")).toEqual({ text: "Check the oven.", scheduled: { name: "Oven", kind: "timer" } });
	expect(parseScheduled(formatScheduled({ ...timer, final: true, missed: 2 }, "Check."))).toEqual({ text: "Check.", scheduled: { name: "Oven", kind: "timer" } });
	expect(parseScheduled(formatScheduled(watch, "Tell me."))).toEqual({ text: "Tell me.", scheduled: { name: "build fails", kind: "watch" } });
	expect(parseScheduled(formatScheduled({ ...watch, lines: [] }, "Tell me."))).toEqual({ text: "Tell me.", scheduled: { name: "build fails", kind: "watch" } });
	expect(parseScheduled("just a message (2 missed runs collapsed into this one)")).toEqual({ text: "just a message (2 missed runs collapsed into this one)" });
});

// ───────────────────────────── the tools ─────────────────────────────

test("each task tool sends its Request and returns one line", async () => {
	const engine = start();
	engine.onRequest = (request) => {
		switch (request.method) {
			case "task_schedule": {
				const p = request.params;
				if (p.kind === "watch") return { ok: true, data: info({ name: p.name, kind: "watch", status: "watching" }) };
				return {
					ok: true,
					data: info({ name: p.name, kind: p.kind, selfPaced: !!p.selfPaced, everyMs: p.everyMs, nextRunAt: p.at ?? (p.inMs ? Date.now() + p.inMs : at(14, 22)) }),
				};
			}
			case "task_list":
				return { ok: true, data: { tasks: [info({ name: "DM", kind: "loop", everyMs: 120_000, nextRunAt: at(14, 22), runs: 3 })] } };
			case "task_cancel":
				return { ok: true, data: info({ name: "Oven" }) };
		}
		return undefined;
	};
	const steps: FauxStep[] = [
		call("schedule_task", { name: "Oven", prompt: "Check the oven.", at: "23:59" }),
		call("schedule_task", { name: "DM", prompt: "Check DMs.", every: "2m" }),
		call("schedule_task", { name: "Deploy", prompt: "Check the deploy.", in: "5m", selfPaced: true }),
		call("watch", { description: "build fails", command: "tail -f build.log", prompt: "Tell me what failed." }),
		call("list_tasks"),
		call("cancel_task", { id: " 3f9a2c1d " }),
		{ text: "ok" },
	];
	await engine.configure({ faux: { replies: steps } });
	const before = Date.now();
	await engine.prompt("set things up");

	const requests = taskRequests(engine);
	expect(requests.map((r) => r.method)).toEqual(["task_schedule", "task_schedule", "task_schedule", "task_schedule", "task_list", "task_cancel"]);
	const [oven, dm, deploy, watch, , cancel] = requests as Extract<Request, { method: "task_schedule" | "task_cancel" }>[];
	expect(oven?.params).toMatchObject({ name: "Oven", prompt: "Check the oven.", kind: "timer", spoken: false });
	expect(oven?.params).not.toHaveProperty("from");
	expect(dm?.params).toEqual({ name: "DM", prompt: "Check DMs.", kind: "loop", everyMs: 120_000, spoken: false });
	expect(deploy?.params).toEqual({ name: "Deploy", prompt: "Check the deploy.", kind: "loop", selfPaced: true, inMs: 300_000, spoken: false });
	expect(watch?.params).toMatchObject({
		name: "build fails",
		kind: "watch",
		command: "tail -f build.log",
		description: "build fails",
		prompt: "Tell me what failed.",
		spoken: false,
	});
	expect((watch?.params as { shell?: unknown }).shell).toEqual(
		process.platform === "win32" ? { kind: "powershell" } : { kind: "bash", path: expect.any(String) },
	);
	expect(cancel?.params).toEqual({ id: "3f9a2c1d" });
	expect((oven?.params as { at: number }).at).toBeGreaterThan(before);

	const details = (await toolRows(engine)).map((r) => [r.name, r.ok, r.detail]);
	expect(details).toEqual([
		["schedule_task", true, expect.stringMatching(/^Scheduled 3f9a2c1d "Oven": once at \d\d:\d\d\.$/)],
		["schedule_task", true, 'Scheduled 3f9a2c1d "DM": every 2m, next at 14:22.'],
		["schedule_task", true, expect.stringMatching(/^Scheduled 3f9a2c1d "Deploy": self-paced, first run at \d\d:\d\d\.$/)],
		["watch", true, 'Watching 3f9a2c1d "build fails".'],
		["list_tasks", true, '3f9a2c1d  "DM"  loop every 2m  next 14:22  runs 3  scheduled'],
		["cancel_task", true, 'Cancelled "Oven".'],
	]);
	await engine.shutdown();
}, T);

test("list_tasks with nothing scheduled says so", async () => {
	const engine = start();
	engine.onRequest = (request) => (request.method === "task_list" ? { ok: true, data: { tasks: [] } } : undefined);
	await engine.configure({ faux: { replies: [call("list_tasks"), { text: "ok" }] } });
	await engine.prompt("what's scheduled?");
	expect((await toolRows(engine))[0]).toMatchObject({ ok: true, detail: "No scheduled tasks." });
	await engine.shutdown();
}, T);

test("the engine's own errors never reach the shell", async () => {
	const engine = start();
	await engine.configure({
		faux: {
			replies: [
				call("schedule_task", { name: "a", prompt: "p", in: "1h30m" }),
				call("schedule_task", { name: "a", prompt: "p", at: "tea time" }),
				call("schedule_task", { name: "a", prompt: "p", in: "5m", every: "5m" }),
				call("schedule_task", { name: "a", prompt: "p" }),
				call("schedule_task", { name: "a", prompt: "p", every: "5m", selfPaced: true }),
				call("next_wakeup", { in: "10m" }),
				{ text: "ok" },
			],
		},
	});
	await engine.prompt("try");
	expect(taskRequests(engine)).toHaveLength(0);
	expect((await toolRows(engine)).map((r) => [r.ok, r.detail])).toEqual([
		[false, ERR_DURATION],
		[false, ERR_TIME],
		[false, ERR_ONE_OF],
		[false, ERR_ONE_OF],
		[false, ERR_SELF_PACED],
		[false, ERR_WAKEUP_PLACE],
	]);
	await engine.shutdown();
}, T);

test("a shell error Response is the tool's error, unchanged", async () => {
	const engine = start();
	engine.onRequest = (request) => {
		if (request.method === "task_schedule") return { ok: false, error: "Too many tasks: 50 are scheduled." };
		if (request.method === "task_cancel") return { ok: false, error: "No task with id deadbeef." };
		return undefined;
	};
	await engine.configure({
		faux: {
			replies: [
				call("schedule_task", { name: "a", prompt: "p", in: "5m" }),
				call("watch", { description: "d", command: "echo hi", prompt: "p" }),
				call("cancel_task", { id: "deadbeef" }),
				{ text: "ok" },
			],
		},
	});
	await engine.prompt("try");
	expect((await toolRows(engine)).map((r) => [r.ok, r.detail])).toEqual([
		[false, "Too many tasks: 50 are scheduled."],
		[false, "Too many tasks: 50 are scheduled."],
		[false, "No task with id deadbeef."],
	]);
	await engine.shutdown();
}, T);

test("a scheduled run passes its job id as from; a typed prompt doesn't; spoken follows the prompt", async () => {
	const engine = start();
	engine.onRequest = (request) => {
		if (request.method === "task_wakeup") return { ok: true, data: { task: info({ name: "deploy", kind: "loop", selfPaced: true, nextRunAt: at(14, 29) }) } };
		if (request.method === "task_cancel") return { ok: true, data: info({ name: "deploy" }) };
		if (request.method === "task_schedule") return { ok: true, data: info({ name: "x" }) };
		return undefined;
	};
	await engine.configure({
		faux: {
			replies: [
				call("next_wakeup", { in: "10m", reason: "deploy still rolling out" }),
				call("next_wakeup", { stop: true }),
				call("cancel_task", { id: "3f9a2c1d" }),
				call("schedule_task", { name: "x", prompt: "p", in: "5m" }),
				{ text: "ok" },
				call("cancel_task", { id: "3f9a2c1d" }),
				call("schedule_task", { name: "x", prompt: "p", in: "5m" }),
				call("next_wakeup", {}),
				{ text: "ok" },
			],
		},
	});
	const run: ScheduledRun = { jobId: "9e8d7c6b", name: "deploy", kind: "loop", selfPaced: true };
	await engine.prompt("check the deploy", { scheduled: run, spoken: true });
	const first = taskRequests(engine);
	expect(first.map((r) => [r.method, r.params])).toEqual([
		["task_wakeup", { from: "9e8d7c6b", delayMs: 600_000, reason: "deploy still rolling out" }],
		["task_wakeup", { from: "9e8d7c6b", stop: true }],
		["task_cancel", { id: "3f9a2c1d", from: "9e8d7c6b" }],
		["task_schedule", expect.objectContaining({ from: "9e8d7c6b", spoken: true })],
	]);
	const rows = await toolRows(engine);
	expect(rows.slice(0, 2).map((r) => r.detail)).toEqual(['Next run of "deploy" at 14:29 (deploy still rolling out).', 'Stopped "deploy".']);

	const count = engine.records.length;
	await engine.prompt("typed", {});
	const typed = taskRequests(engine).slice(first.length);
	expect(typed.map((r) => r.params)).toEqual([{ id: "3f9a2c1d" }, expect.not.objectContaining({ from: expect.anything() })]);
	expect((typed[1]?.params as { spoken: boolean }).spoken).toBe(false);
	expect(engine.records.slice(count).some((r) => r.type === "request" && r.method === "task_wakeup")).toBe(false);
	const last = (await toolRows(engine)).at(-1);
	expect(last).toMatchObject({ name: "next_wakeup", ok: false, detail: ERR_WAKEUP_PLACE });
	await engine.shutdown();
}, T);

test("next_wakeup needs a delay or stop", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [call("next_wakeup", { reason: "later" }), { text: "ok" }] } });
	await engine.prompt("go", { scheduled: { jobId: "9e8d7c6b", name: "d", kind: "loop", selfPaced: true } });
	expect(taskRequests(engine)).toHaveLength(0);
	expect((await toolRows(engine))[0]).toMatchObject({ ok: false, detail: ERR_WAKEUP_ARGS });
	await engine.shutdown();
}, T);

test("task tool calls show a short summary", async () => {
	const engine = start();
	engine.onRequest = (request) => (request.method === "task_list" ? { ok: true, data: { tasks: [] } } : { ok: false, error: "no" });
	await engine.configure({
		faux: {
			replies: [
				call("schedule_task", { name: "Oven", prompt: "p", in: "5m" }),
				call("watch", { description: "build fails", command: "tail -f build.log", prompt: "p" }),
				call("list_tasks"),
				call("cancel_task", { id: "3f9a2c1d" }),
				{ text: "ok" },
			],
		},
	});
	const { records } = await engine.prompt("go");
	expect(records.filter((r) => r.type === "tool_start").map((r) => (r.type === "tool_start" ? [r.name, r.summary] : []))).toEqual([
		["schedule_task", "Oven"],
		["watch", "build fails"],
		["list_tasks", "scheduled tasks"],
		["cancel_task", "3f9a2c1d"],
	]);
	await engine.shutdown();
}, T);

// ───────────────────────────── scheduled prompts ─────────────────────────────

test("a scheduled prompt reaches the model as [scheduled: …] / [watch: …] and the transcript parses it back", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [{ echoUser: true }, { echoUser: true }, { echoUser: true }] } });
	const now = { app: "notepad.exe", windowTitle: "notes" };

	const timer = await engine.prompt("Check the oven.", { scheduled: { jobId: "a1", name: "Oven", kind: "timer" }, now });
	expect(timer.end.text).toBe('[scheduled: Oven] Check the oven.\n\n<now app="notepad.exe" window="notes"></now>\n[images:0]');

	const loop = await engine.prompt("Check DMs.", { scheduled: { jobId: "a2", name: "DM", kind: "loop", final: true, missed: 3 } });
	expect(loop.end.text).toBe("[scheduled: DM] Check DMs. (3 missed runs collapsed into this one) (final run: this task expired after 7 days)\n[images:0]");

	const watch = await engine.prompt("Tell me what failed.", {
		scheduled: { jobId: "a3", name: "build fails", kind: "watch", description: "build fails", lines: ["FAIL a", "FAIL b"], dropped: 2 },
	});
	expect(watch.end.text).toBe("[watch: build fails]\nFAIL a\nFAIL b\n\nTell me what failed. (2 earlier lines dropped)\n[images:0]");

	const users = (await transcript(engine)).filter((t): t is Extract<TranscriptItem, { kind: "user" }> => t.kind === "user");
	expect(users.map((u) => [u.text, u.scheduled])).toEqual([
		["Check the oven.", { name: "Oven", kind: "timer" }],
		["Check DMs.", { name: "DM", kind: "timer" }],
		["Tell me what failed.", { name: "build fails", kind: "watch" }],
	]);
	expect(users[0]?.now).toEqual(now);
	await engine.shutdown();
}, T);

// ───────────────────────────── notices ─────────────────────────────

test("a notice is announced and recorded without starting a reply, and the model sees it next", async () => {
	const engine = start();
	await engine.configure({ faux: { replies: [{ echoThread: true }] } });
	const from = engine.records.length;
	const result = await engine.call({ type: "notice", text: 'Missed: "Oven" was due at 14:20.' });
	expect(result.ok).toBe(true);
	const event = engine.records.slice(from).find((r) => r.type === "notice");
	expect(event).toMatchObject({ type: "notice", text: 'Missed: "Oven" was due at 14:20.', at: expect.any(Number) });
	expect(engine.records.slice(from).some((r) => r.type === "thinking" || r.type === "reply_end" || r.type === "text_delta")).toBe(false);

	expect(await transcript(engine)).toEqual([{ kind: "notice", id: expect.any(String), text: 'Missed: "Oven" was due at 14:20.', at: expect.any(Number) }]);

	const { end } = await engine.prompt("anything new?");
	expect(end.text).toBe('Missed: "Oven" was due at 14:20.\n---\nanything new?');
	const items = await transcript(engine);
	expect(items.map((i) => i.kind)).toEqual(["notice", "user", "assistant"]);

	// It is in the session file: a restarted engine still shows it.
	await engine.shutdown();
	const again = engine.restart();
	running.push(again);
	await again.configure();
	expect((await transcript(again)).map((i) => i.kind)).toEqual(["notice", "user", "assistant"]);
	await again.shutdown();
}, T);

test("a notice during a reply waits for the step to end and doesn't disturb it", async () => {
	const engine = start();
	const words = "one two three four five six seven eight nine ten";
	await engine.configure({ faux: { tokensPerSecond: 40, replies: [{ text: words }, { echoThread: true }] } });
	const id = "slow";
	const from = engine.records.length;
	engine.send({ type: "prompt", id, text: "count" });
	await engine.waitFor((r) => r.type === "text_delta" && r.id === id, from);
	const result = await engine.call({ type: "notice", text: "Watch ended." });
	expect(result.ok).toBe(true);
	const end = await engine.waitFor((r) => r.type === "reply_end" && r.id === id, from);
	expect(end).toMatchObject({ aborted: false, text: words });
	expect(engine.records.slice(from).filter((r) => r.type === "notice")).toHaveLength(1);
	expect((await transcript(engine)).map((i) => i.kind)).toEqual(["user", "assistant", "notice"]);
	expect((await engine.prompt("next")).end.text).toBe("count\n---\nWatch ended.\n---\nnext");
	await engine.shutdown();
}, T);

// ───────────────────────────── permissions ─────────────────────────────

test("watch asks like powershell: its first word is the key, a compound command always asks", async () => {
	const engine = start();
	const decisions = ["deny", "allow_once", "always"];
	engine.onRequest = (request) => {
		if (request.method === "permission") return { ok: true, data: { decision: decisions.shift() ?? "deny" } };
		if (request.method === "task_schedule") return { ok: true, data: info({ name: "w", kind: "watch", status: "watching" }) };
		return undefined;
	};
	const watch = (command: string) => call("watch", { description: "w", command, prompt: "p" });
	await engine.configure({
		askBeforeRunning: true,
		alwaysAllow: ["powershell:ping"],
		faux: {
			replies: [
				watch("tail -f a.log"),
				watch("tail -f a.log"),
				watch("tail -f b.log"),
				watch("ping -t host"),
				watch("ping -t host | Select-String ok"),
				{ text: "ok" },
			],
		},
	});
	await engine.prompt("watch things");
	const asks = permissionRequests(engine.records).map((r) => r.params);
	// denied, allowed once, allowed always; "ping -t host" is covered by the setting; the pipeline asks.
	expect(asks.map((a) => [a.tool, a.allowKey])).toEqual([
		["watch", "powershell:tail"],
		["watch", "powershell:tail"],
		["watch", "powershell:tail"],
		["watch", "powershell:ping"],
	]);
	expect(asks[0]?.summary).toContain("tail -f a.log");
	const scheduled = taskRequests(engine).filter((r) => r.method === "task_schedule");
	expect(scheduled).toHaveLength(3); // the denied one never reached the shell
	const rows = await toolRows(engine);
	expect(rows.map((r) => r.ok)).toEqual([false, true, true, true, false]);
	expect(rows[0]?.detail).toBe(DECLINED);
	await engine.shutdown();
}, T);

test("the other task tools never ask", async () => {
	const engine = start();
	engine.onRequest = (request) => {
		if (request.method === "task_schedule") return { ok: true, data: info() };
		if (request.method === "task_list") return { ok: true, data: { tasks: [] } };
		if (request.method === "task_cancel") return { ok: true, data: info() };
		return undefined;
	};
	await engine.configure({
		askBeforeRunning: true,
		faux: { replies: [call("schedule_task", { name: "a", prompt: "p", in: "5m" }), call("list_tasks"), call("cancel_task", { id: "x" }), { text: "ok" }] },
	});
	await engine.prompt("go");
	expect(permissionRequests(engine.records)).toHaveLength(0);
	await engine.shutdown();
}, T);

test("in a scheduled run the desktop tools that act ask even with the switch off", async () => {
	const asked: string[] = [];
	let scheduled = true;
	const gate = (policy = policyFrom(false, [])): GateDeps => ({
		policy: () => policy,
		home: "/home/u",
		replyId: () => "task-1",
		scheduled: () => scheduled,
		ask: async (request) => {
			asked.push(request.tool);
			return { decision: "allow_once" };
		},
		describe: (tool, args) => (tool.startsWith("desktop_") ? { summary: `${tool} ${String(args.ref ?? "")}`, allowKey: "desktop:notepad.exe", coverable: true } : undefined),
	});

	for (const tool of ["desktop_act", "desktop_press", "desktop_window"]) await checkPermission(tool, { ref: "@s1:e1" }, gate());
	expect(asked).toEqual(["desktop_act", "desktop_press", "desktop_window"]);

	// Reading and the other tools stay quiet, as does everything outside a scheduled run.
	asked.length = 0;
	for (const tool of ["desktop_observe", "desktop_windows", "desktop_wait", "clipboard_write", "write", "bash", "watch"]) await checkPermission(tool, { command: "ls" }, gate());
	scheduled = false;
	for (const tool of ["desktop_act", "desktop_press", "desktop_window"]) await checkPermission(tool, {}, gate());
	expect(asked).toEqual([]);

	// An Always allow on the app's key covers it, in a scheduled run too.
	scheduled = true;
	await checkPermission("desktop_act", {}, gate(policyFrom(false, ["desktop:notepad.exe"])));
	expect(asked).toEqual([]);

	// A denial is a denial.
	const deny: GateDeps = { ...gate(), ask: async () => ({ decision: "deny" }) };
	await expect(checkPermission("desktop_window", {}, deny)).rejects.toThrow(DECLINED);
});
