//! Scheduled tasks (docs/ARCHITECTURE.md, "Scheduled tasks"; SPEC §7a): the jobs, their rules,
//! `tasks.json`, and when each one runs. Pure: every call takes `now` (epoch ms), so the rules
//! are tested without a clock. `scheduler.rs` drives it (the tick, the engine, the processes).
//!
//! What a call wants done outside (notices to send, watch commands to start or kill) collects
//! in `Effects`, which the scheduler takes after each call.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "tasks.json";
const VERSION: u32 = 1;

const SECOND: u64 = 1000;
const MINUTE: u64 = 60 * SECOND;
const DAY: u64 = 24 * 60 * MINUTE;

pub const MAX_JOBS: usize = 50;
pub const MAX_WATCHES: usize = 5;
/// Shortest interval or timer delay.
pub const MIN_INTERVAL: u64 = 15 * SECOND;
/// Self-paced delays.
pub const MIN_DELAY: u64 = MINUTE;
pub const MAX_DELAY: u64 = 60 * MINUTE;
/// How far ahead a timer may be, and how long loops and watches live.
pub const MAX_AHEAD: u64 = 7 * DAY;
pub const LIFETIME: u64 = 7 * DAY;
/// A timer more than this late (asleep, or closed) doesn't run.
pub const LATE: u64 = 10 * MINUTE;
/// A self-paced run that picks no next time gets one more run this much later.
pub const FALLBACK: u64 = 20 * MINUTE;
/// Jitter is at most half the gap, and never more than this.
pub const JITTER_CAP: u64 = 30 * MINUTE;
/// Failures in a row that end a job.
pub const FAILURE_LIMIT: u32 = 3;
/// A watch command that exits non-zero this soon after starting failed.
pub const QUICK_EXIT: u64 = 10 * SECOND;
pub const NAME_CAP: usize = 40;

// Watch lines.
pub const LINE_CAP: usize = 500;
pub const LINES_KEPT: usize = 50;
/// A burst of lines ends this long after its last line.
pub const BURST_GAP: u64 = SECOND;
/// At most one wake per this long.
pub const WAKE_GAP: u64 = 15 * SECOND;

// The Response errors (one line each).
pub const TOO_MANY_TASKS: &str = "Too many tasks: 50 are scheduled.";
pub const TOO_MANY_WATCHES: &str = "Too many watches: 5 are running.";
pub const TOO_SHORT: &str = "Interval too short: the minimum is 15s.";
pub const BAD_DELAY: &str = "Delays are 1m to 60m.";
pub const TOO_FAR: &str = "Too far ahead: at most 7 days.";
pub const ONLY_ITSELF: &str = "A scheduled run can only change or cancel itself.";
pub const NOT_SELF_PACED: &str = "next_wakeup only works in a self-paced run.";
pub const EXPIRED: &str = "This task expired. Ask the user to set it up again.";
// Not in the contract; the engine's tools never send these.
const NO_TIME: &str = "A timer needs a time.";
const NO_INTERVAL: &str = "A loop needs every, or selfPaced with in.";
const NO_COMMAND: &str = "A watch needs a command.";

fn unknown(id: &str) -> String {
    format!("No task with id {id}.")
}

// ───────────────────────────── types ─────────────────────────────

/// `TaskKind` in engine/src/protocol.ts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Timer,
    Loop,
    Watch,
}

/// `TaskStatus` in engine/src/protocol.ts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Scheduled,
    Due,
    Running,
    Waiting,
    Watching,
}

/// `WatchShell` in engine/src/protocol.ts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WatchShell {
    /// `"powershell"` or `"bash"`.
    pub kind: String,
    /// bash: its path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// One job as kept in `tasks.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub prompt: String,
    #[serde(default)]
    pub self_paced: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<WatchShell>,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    /// When the next run is due, jitter included. Absent for watches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<u64>,
    #[serde(default)]
    pub runs: u32,
    #[serde(default)]
    pub failures: u32,
    #[serde(default)]
    pub spoken: bool,
    #[serde(default)]
    pub fallback_used: bool,
}

impl Job {
    fn expired(&self, now: u64) -> bool {
        self.expires_at.is_some_and(|at| at <= now)
    }
}

/// `TaskInfo` in engine/src/protocol.ts.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub self_paced: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub every_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    pub runs: u32,
    pub status: Status,
}

/// `TaskScheduleParams` in engine/src/protocol.ts.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScheduleParams {
    pub name: String,
    pub prompt: String,
    pub kind: Option<Kind>,
    pub at: Option<u64>,
    pub every_ms: Option<u64>,
    pub self_paced: bool,
    pub in_ms: Option<u64>,
    pub command: Option<String>,
    pub description: Option<String>,
    pub shell: Option<WatchShell>,
    pub spoken: bool,
    pub from: Option<String>,
}

/// `ScheduledRun` in engine/src/protocol.ts: sent with the prompt of a run.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRun {
    pub job_id: String,
    pub name: String,
    pub kind: Kind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub self_paced: Option<bool>,
    #[serde(rename = "final", skip_serializing_if = "Option::is_none")]
    pub final_run: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dropped: Option<u32>,
}

/// A run to start now: the scheduler sends it as a `prompt`.
#[derive(Clone, Debug, PartialEq)]
pub struct Fire {
    /// `task-<n>`
    pub prompt_id: String,
    pub text: String,
    /// The request that set the job up was spoken.
    pub spoken: bool,
    pub run: ScheduledRun,
}

/// Work for the scheduler, collected by the calls that cause it.
#[derive(Debug, Default, PartialEq)]
pub struct Effects {
    /// `notice` commands for the engine, in order.
    pub notices: Vec<String>,
    /// Watch jobs whose command should be (re)started.
    pub start_watches: Vec<String>,
    /// Watch jobs whose command should be killed (cancelled, expired, ended).
    pub stop_watches: Vec<String>,
}

/// The run going on now.
#[derive(Clone, Debug, PartialEq)]
struct Run {
    job_id: String,
    prompt_id: String,
    final_run: bool,
    /// An `error` event for the run: its errorKind.
    error: Option<String>,
    /// The run called `next_wakeup` with a delay.
    decided: bool,
}

/// A watch's state while Winku runs (never written to disk).
#[derive(Debug, Default)]
struct WatchState {
    lines: LineBuffer,
    started_at: Option<u64>,
    /// The command exited with this code; the job ends once its lines have run.
    exit: Option<i32>,
    /// Killed at expiry; its final run is waiting.
    stopped: bool,
}

// ───────────────────────────── the jobs ─────────────────────────────

/// All jobs and what is going on with them.
#[derive(Debug, Default)]
pub struct Tasks {
    jobs: Vec<Job>,
    running: Option<Run>,
    /// Timers seen due on time: they wait for an idle moment however long it takes.
    seen_due: HashSet<String>,
    watches: HashMap<String, WatchState>,
    next_run: u64,
    effects: Effects,
}

impl Tasks {
    /// Jobs as loaded from the file, after Winku was closed: the restart pass. Late timers end,
    /// loops that missed a run run at the first idle moment, watches start again; each gets a
    /// notice.
    pub fn restore(jobs: Vec<Job>, now: u64) -> Self {
        let mut tasks = Tasks::default();
        for job in jobs {
            if tasks.jobs.iter().any(|j| j.id == job.id) {
                continue;
            }
            match job.kind {
                Kind::Timer => {
                    let at = job.next_run_at.unwrap_or(now);
                    if at <= now && now - at > LATE {
                        tasks.effects.notices.push(format!(
                            "Missed while Winku was closed: \"{}\" was due at {}.",
                            job.name,
                            clock(at)
                        ));
                        continue;
                    }
                    if at <= now {
                        tasks.seen_due.insert(job.id.clone());
                    }
                }
                Kind::Loop => {
                    let at = job.next_run_at.unwrap_or(now);
                    if at < now {
                        tasks.effects.notices.push(format!(
                            "Missed while Winku was closed: \"{}\" was due at {}.",
                            job.name,
                            clock(at)
                        ));
                    }
                }
                Kind::Watch => {
                    if !job.expired(now) {
                        tasks.effects.start_watches.push(job.id.clone());
                        tasks
                            .effects
                            .notices
                            .push(format!("Restarted watch \"{}\".", job.name));
                    }
                    tasks.watches.insert(
                        job.id.clone(),
                        WatchState {
                            stopped: job.expired(now),
                            ..WatchState::default()
                        },
                    );
                }
            }
            tasks.jobs.push(job);
        }
        tasks
    }

    pub fn jobs(&self) -> &[Job] {
        &self.jobs
    }

    pub fn job(&self, id: &str) -> Option<&Job> {
        self.jobs.iter().find(|j| j.id == id)
    }

    fn job_mut(&mut self, id: &str) -> Option<&mut Job> {
        self.jobs.iter_mut().find(|j| j.id == id)
    }

    pub fn take_effects(&mut self) -> Effects {
        std::mem::take(&mut self.effects)
    }

    /// The job whose run is going on, and that run's prompt id.
    pub fn running(&self) -> Option<(&str, &str)> {
        self.running
            .as_ref()
            .map(|r| (r.job_id.as_str(), r.prompt_id.as_str()))
    }

    /// `task_schedule`.
    pub fn schedule(&mut self, params: ScheduleParams, now: u64) -> Result<TaskInfo, String> {
        if params.from.is_some() {
            return Err(ONLY_ITSELF.into());
        }
        if self.jobs.len() >= MAX_JOBS {
            return Err(TOO_MANY_TASKS.into());
        }
        let kind = params.kind.unwrap_or(Kind::Timer);
        let id = self.fresh_id(now);
        let mut job = Job {
            id: id.clone(),
            name: String::new(),
            kind,
            prompt: params.prompt,
            self_paced: false,
            every_ms: None,
            command: None,
            description: None,
            shell: None,
            created_at: now,
            expires_at: None,
            next_run_at: None,
            runs: 0,
            failures: 0,
            spoken: params.spoken,
            fallback_used: false,
        };
        match kind {
            Kind::Timer => {
                let at = params.at.ok_or(NO_TIME)?;
                if at < now + MIN_INTERVAL {
                    return Err(TOO_SHORT.into());
                }
                if at > now + MAX_AHEAD {
                    return Err(TOO_FAR.into());
                }
                job.next_run_at = Some(at);
            }
            Kind::Loop if params.self_paced => {
                let delay = params.in_ms.ok_or(NO_INTERVAL)?;
                check_delay(delay)?;
                job.self_paced = true;
                job.expires_at = Some(now + LIFETIME);
                job.next_run_at = Some(now + delay + jitter(&id, delay));
            }
            Kind::Loop => {
                let every = params.every_ms.ok_or(NO_INTERVAL)?;
                if every < MIN_INTERVAL {
                    return Err(TOO_SHORT.into());
                }
                job.every_ms = Some(every);
                job.expires_at = Some(now + LIFETIME);
                job.next_run_at = Some(now + every + jitter(&id, every));
            }
            Kind::Watch => {
                if self.jobs.iter().filter(|j| j.kind == Kind::Watch).count() >= MAX_WATCHES {
                    return Err(TOO_MANY_WATCHES.into());
                }
                let command = params
                    .command
                    .filter(|c| !c.trim().is_empty())
                    .ok_or(NO_COMMAND)?;
                job.command = Some(command);
                job.description = params
                    .description
                    .map(|d| d.trim().to_string())
                    .filter(|d| !d.is_empty());
                job.shell = params.shell;
                job.expires_at = Some(now + LIFETIME);
                self.watches.insert(id.clone(), WatchState::default());
                self.effects.start_watches.push(id.clone());
            }
        }
        job.name = job_name(&params.name, job.description.as_deref(), &job.prompt);
        self.jobs.push(job);
        Ok(self.info(&id, now, false).expect("just added"))
    }

    /// `task_wakeup`, from a self-paced run: its next delay, or stop. `Ok(None)` after stop.
    pub fn wakeup(
        &mut self,
        from: &str,
        delay_ms: Option<u64>,
        stop: bool,
        now: u64,
    ) -> Result<Option<TaskInfo>, String> {
        let job = self.job(from).ok_or_else(|| unknown(from))?;
        if job.kind != Kind::Loop || !job.self_paced {
            return Err(NOT_SELF_PACED.into());
        }
        let final_run = self
            .running
            .as_ref()
            .is_some_and(|r| r.job_id == from && r.final_run);
        if final_run || job.expired(now) {
            return Err(EXPIRED.into());
        }
        if stop {
            self.remove(from);
            return Ok(None);
        }
        let delay = delay_ms.ok_or(BAD_DELAY)?;
        check_delay(delay)?;
        let job = self.job_mut(from).expect("checked above");
        job.next_run_at = Some(now + delay + jitter(from, delay));
        job.fallback_used = false;
        if let Some(run) = self.running.as_mut().filter(|r| r.job_id == from) {
            run.decided = true;
        }
        Ok(self.info(from, now, false))
    }

    /// `task_cancel` (and the Settings window's Cancel, without `from`).
    pub fn cancel(&mut self, id: &str, from: Option<&str>, now: u64) -> Result<TaskInfo, String> {
        if from.is_some_and(|from| from != id) {
            return Err(ONLY_ITSELF.into());
        }
        let info = self.info(id, now, false).ok_or_else(|| unknown(id))?;
        self.remove(id);
        Ok(info)
    }

    /// Ends a job: out of the list and the file; a watch's command is killed.
    fn remove(&mut self, id: &str) {
        let Some(index) = self.jobs.iter().position(|j| j.id == id) else {
            return;
        };
        let job = self.jobs.remove(index);
        self.seen_due.remove(id);
        if job.kind == Kind::Watch {
            self.watches.remove(id);
            self.effects.stop_watches.push(id.to_string());
        }
    }

    fn end_with_notice(&mut self, id: &str, notice: String) {
        self.remove(id);
        self.effects.notices.push(notice);
    }

    /// The tick. Ends late timers and finished watches, kills expired watches, and when Winku
    /// is idle (`idle`) and no run is going, starts the job that has been due longest.
    pub fn poll(&mut self, now: u64, idle: bool) -> Option<Fire> {
        self.housekeeping(now);
        if !idle || self.running.is_some() {
            return None;
        }
        let (id, _) = self
            .jobs
            .iter()
            .filter_map(|job| self.due_since(job, now).map(|at| (job.id.clone(), at)))
            .min_by_key(|(_, at)| *at)?;
        Some(self.start(&id, now))
    }

    fn housekeeping(&mut self, now: u64) {
        let running = self.running.as_ref().map(|r| r.job_id.clone());
        let mut late = Vec::new();
        let mut ended = Vec::new();
        for job in &self.jobs {
            if running.as_deref() == Some(job.id.as_str()) {
                continue;
            }
            match job.kind {
                Kind::Timer => {
                    let at = job.next_run_at.unwrap_or(now);
                    if at <= now && !self.seen_due.contains(&job.id) {
                        if now - at > LATE {
                            late.push((job.id.clone(), job.name.clone(), at));
                        } else {
                            self.seen_due.insert(job.id.clone());
                        }
                    }
                }
                Kind::Watch => {
                    let Some(state) = self.watches.get_mut(&job.id) else {
                        continue;
                    };
                    if job.expired(now) && !state.stopped {
                        state.stopped = true;
                        self.effects.stop_watches.push(job.id.clone());
                    }
                    if let Some(code) = state.exit {
                        if state.lines.is_empty() && !state.stopped {
                            ended.push((job.id.clone(), job.name.clone(), code));
                        }
                    }
                }
                Kind::Loop => {}
            }
        }
        for (id, name, at) in late {
            self.end_with_notice(&id, format!("Missed: \"{name}\" was due at {}.", clock(at)));
        }
        for (id, name, code) in ended {
            self.end_with_notice(&id, format!("Watch \"{name}\" ended (exit {code})."));
        }
    }

    /// When a job became due, if it is.
    fn due_since(&self, job: &Job, now: u64) -> Option<u64> {
        match job.kind {
            Kind::Timer | Kind::Loop => {
                let at = job.next_run_at.unwrap_or(now);
                let at = job.expires_at.map_or(at, |exp| at.min(exp));
                (at <= now).then_some(at)
            }
            Kind::Watch => {
                let state = self.watches.get(&job.id)?;
                if job.expired(now) {
                    return job.expires_at;
                }
                state.lines.ready_since(now)
            }
        }
    }

    fn start(&mut self, id: &str, now: u64) -> Fire {
        self.next_run += 1;
        let prompt_id = format!("task-{}", self.next_run);
        let job = self.job(id).expect("due job exists").clone();
        let final_run = job.expired(now);
        let mut run = ScheduledRun {
            job_id: job.id.clone(),
            name: job.name.clone(),
            kind: job.kind,
            self_paced: job.self_paced.then_some(true),
            final_run: final_run.then_some(true),
            missed: None,
            description: None,
            lines: None,
            dropped: None,
        };
        match job.kind {
            Kind::Timer => {
                self.seen_due.remove(id);
            }
            Kind::Loop => {
                if let (Some(every), Some(at)) = (job.every_ms, job.next_run_at) {
                    // Fires since `at`, up to now (or the expiry), collapse into this run.
                    let until = job.expires_at.map_or(now, |exp| exp.min(now));
                    let missed = until.saturating_sub(at) / every;
                    run.missed = (missed > 0).then_some(missed);
                    if !final_run {
                        let next = at + (now.saturating_sub(at) / every + 1) * every;
                        self.job_mut(id).expect("exists").next_run_at = Some(next);
                    }
                }
            }
            Kind::Watch => {
                run.description = job.description.clone();
                if let Some(state) = self.watches.get_mut(id) {
                    let (lines, dropped) = state.lines.take(now);
                    run.lines = (!lines.is_empty()).then_some(lines);
                    run.dropped = (dropped > 0).then_some(dropped);
                }
            }
        }
        self.running = Some(Run {
            job_id: job.id.clone(),
            prompt_id: prompt_id.clone(),
            final_run,
            error: None,
            decided: false,
        });
        Fire {
            prompt_id,
            text: job.prompt,
            spoken: job.spoken,
            run,
        }
    }

    /// An `error` event for a prompt id: a failure if it is the run's.
    pub fn run_error(&mut self, prompt_id: &str, error_kind: &str) {
        if let Some(run) = self.running.as_mut().filter(|r| r.prompt_id == prompt_id) {
            run.error = Some(error_kind.to_string());
        }
    }

    /// `reply_end` for a prompt id: if it is the run's, the run is over and the job moves on.
    pub fn run_ended(&mut self, prompt_id: &str, now: u64) {
        let Some(run) = self.running.take_if(|r| r.prompt_id == prompt_id) else {
            return;
        };
        let Some(job) = self.job_mut(&run.job_id) else {
            return; // Cancelled or stopped during the run.
        };
        job.runs += 1;
        if let Some(reason) = &run.error {
            job.failures += 1;
            if job.failures >= FAILURE_LIMIT {
                let notice = format!(
                    "Stopped \"{}\": the last {FAILURE_LIMIT} runs failed ({reason}).",
                    job.name
                );
                self.end_with_notice(&run.job_id, notice);
                return;
            }
        } else {
            job.failures = 0;
        }
        if run.final_run {
            self.remove(&run.job_id);
            return;
        }
        match job.kind {
            Kind::Timer => self.remove(&run.job_id),
            Kind::Loop if job.self_paced => {
                if run.decided {
                    return;
                }
                if job.fallback_used {
                    let notice = format!("\"{}\" stopped: it didn't pick a next time.", job.name);
                    self.end_with_notice(&run.job_id, notice);
                } else {
                    job.fallback_used = true;
                    job.next_run_at = Some(now + FALLBACK + jitter(&job.id, FALLBACK));
                }
            }
            Kind::Loop | Kind::Watch => {}
        }
    }

    /// The engine stopped (or a run's prompt was refused): the run failed.
    pub fn run_failed(&mut self, prompt_id: &str, reason: &str, now: u64) {
        self.run_error(prompt_id, reason);
        self.run_ended(prompt_id, now);
    }

    /// A watch command was started.
    pub fn watch_started(&mut self, id: &str, now: u64) {
        if let Some(state) = self.watches.get_mut(id) {
            state.started_at = Some(now);
            state.exit = None;
        }
    }

    /// A watch command couldn't be started: the job ends.
    pub fn watch_start_failed(&mut self, id: &str, error: &str) {
        if let Some(job) = self.job(id) {
            let notice = format!("Watch \"{}\" couldn't start: {error}", job.name);
            self.end_with_notice(id, notice);
        }
    }

    /// A line on a watch command's stdout.
    pub fn watch_line(&mut self, id: &str, line: &str, now: u64) {
        if let Some(state) = self.watches.get_mut(id) {
            if !state.stopped {
                state.lines.push(line, now);
            }
        }
    }

    /// A watch command exited by itself (not killed by the scheduler). A non-zero exit soon
    /// after starting is a failure and the command starts again, until three in a row end the
    /// job. Otherwise the job ends once the lines still waiting have run.
    pub fn watch_exited(&mut self, id: &str, code: i32, stderr_last: Option<&str>, now: u64) {
        let Some(state) = self.watches.get_mut(id) else {
            return;
        };
        if state.stopped {
            return;
        }
        let quick = state
            .started_at
            .is_some_and(|at| now.saturating_sub(at) < QUICK_EXIT);
        let Some(job) = self.jobs.iter_mut().find(|j| j.id == id) else {
            return;
        };
        if code != 0 && quick {
            job.failures += 1;
            if job.failures >= FAILURE_LIMIT {
                let reason = stderr_last
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| cut(s, LINE_CAP))
                    .unwrap_or_else(|| format!("exit {code}"));
                let notice = format!(
                    "Stopped \"{}\": the last {FAILURE_LIMIT} runs failed ({reason}).",
                    job.name
                );
                self.end_with_notice(id, notice);
            } else {
                state.started_at = None;
                self.effects.start_watches.push(id.to_string());
            }
            return;
        }
        job.failures = 0;
        state.exit = Some(code);
        state.lines.flush();
    }

    /// `TaskInfo` for one job. `waiting`: the running job's reply waits for a permission answer.
    fn info(&self, id: &str, now: u64, waiting: bool) -> Option<TaskInfo> {
        let job = self.job(id)?;
        let status = if self.running.as_ref().is_some_and(|r| r.job_id == id) {
            if waiting {
                Status::Waiting
            } else {
                Status::Running
            }
        } else if self.due_since(job, now).is_some() {
            Status::Due
        } else if job.kind == Kind::Watch {
            Status::Watching
        } else {
            Status::Scheduled
        };
        Some(TaskInfo {
            id: job.id.clone(),
            name: job.name.clone(),
            kind: job.kind,
            self_paced: job.self_paced,
            every_ms: job.every_ms,
            description: job.description.clone(),
            next_run_at: if job.kind == Kind::Watch {
                None
            } else {
                job.next_run_at
            },
            expires_at: job.expires_at,
            runs: job.runs,
            status,
        })
    }

    /// Every job, soonest first (watches, with no next run, last).
    pub fn list(&self, now: u64, waiting: bool) -> Vec<TaskInfo> {
        let mut infos: Vec<(u64, TaskInfo)> = self
            .jobs
            .iter()
            .filter_map(|job| {
                let info = self.info(&job.id, now, waiting)?;
                Some((job.created_at, info))
            })
            .collect();
        infos.sort_by_key(|(created, info)| (info.next_run_at.unwrap_or(u64::MAX), *created));
        infos.into_iter().map(|(_, info)| info).collect()
    }

    fn fresh_id(&self, now: u64) -> String {
        use std::hash::{BuildHasher, Hasher};
        let mut salt = 0u64;
        loop {
            let mut hasher = std::hash::RandomState::new().build_hasher();
            hasher.write_u64(now);
            hasher.write_u64(salt);
            let id = format!("{:08x}", hasher.finish() as u32);
            if self.job(&id).is_none() {
                return id;
            }
            salt += 1;
        }
    }
}

fn check_delay(delay: u64) -> Result<(), String> {
    if (MIN_DELAY..=MAX_DELAY).contains(&delay) {
        Ok(())
    } else {
        Err(BAD_DELAY.into())
    }
}

/// The name, trimmed and cut at 40 characters; without one, the description or the prompt's
/// first line.
fn job_name(name: &str, description: Option<&str>, prompt: &str) -> String {
    let name = name.trim();
    let name = if name.is_empty() {
        description
            .unwrap_or_else(|| prompt.lines().next().unwrap_or_default())
            .trim()
    } else {
        name
    };
    let name = if name.is_empty() { "Task" } else { name };
    cut(name, NAME_CAP).trim_end().to_string()
}

fn cut(text: &str, cap: usize) -> String {
    text.chars().take(cap).collect()
}

/// Where in [0, 1) this id falls: stable for a job across restarts.
fn fraction(id: &str) -> f64 {
    let value = u32::from_str_radix(id, 16).unwrap_or_else(|_| {
        id.bytes()
            .fold(0u32, |acc, b| acc.wrapping_mul(31).wrapping_add(b.into()))
    });
    f64::from(value) / (f64::from(u32::MAX) + 1.0)
}

/// How late a loop runs after its time: `fraction(id) × min(gap / 2, 30 min)`.
pub fn jitter(id: &str, gap: u64) -> u64 {
    let span = (gap / 2).min(JITTER_CAP);
    (fraction(id) * span as f64) as u64
}

/// Local `HH:MM`, for notices.
pub fn clock(epoch_ms: u64) -> String {
    use chrono::TimeZone;
    i64::try_from(epoch_ms)
        .ok()
        .and_then(|ms| chrono::Local.timestamp_millis_opt(ms).single())
        .map(|t| t.format("%H:%M").to_string())
        .unwrap_or_else(|| "--:--".into())
}

// ───────────────────────────── watch lines ─────────────────────────────

/// A watch's stdout lines waiting for a run. A burst ends 1 s after its last line, and wakes
/// are at most one per 15 s; a burst that never pauses still wakes once its first line has
/// waited 15 s. At most 50 lines are kept, the oldest dropped and counted.
#[derive(Debug, Default)]
pub struct LineBuffer {
    lines: VecDeque<String>,
    dropped: u32,
    first_at: Option<u64>,
    last_at: Option<u64>,
    last_wake: Option<u64>,
    /// The command exited: whatever is left wakes at once.
    flush: bool,
}

impl LineBuffer {
    pub fn push(&mut self, line: &str, now: u64) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        self.lines.push_back(cut(line, LINE_CAP));
        if self.lines.len() > LINES_KEPT {
            self.lines.pop_front();
            self.dropped += 1;
        }
        self.first_at.get_or_insert(now);
        self.last_at = Some(now);
    }

    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    pub fn flush(&mut self) {
        self.flush = true;
    }

    /// When the lines became ready to wake Winku, if they are.
    pub fn ready_since(&self, now: u64) -> Option<u64> {
        let (first, last) = (self.first_at?, self.last_at?);
        if self.lines.is_empty() {
            return None;
        }
        if self.flush {
            return Some(last);
        }
        let burst_end = (last + BURST_GAP).min(first + WAKE_GAP);
        let at = self
            .last_wake
            .map_or(burst_end, |wake| burst_end.max(wake + WAKE_GAP));
        (at <= now).then_some(at)
    }

    /// The lines, oldest first, and how many were dropped; the buffer starts over.
    pub fn take(&mut self, now: u64) -> (Vec<String>, u32) {
        let lines = self.lines.drain(..).collect();
        let dropped = std::mem::take(&mut self.dropped);
        self.first_at = None;
        self.last_at = None;
        self.last_wake = Some(now);
        (lines, dropped)
    }
}

// ───────────────────────────── the file ─────────────────────────────

#[derive(Serialize, Deserialize)]
struct File {
    version: u32,
    jobs: Vec<Job>,
}

pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

/// The jobs in `tasks.json`. A missing file has none; one that can't be read is renamed
/// `tasks.json.bad`.
pub fn load(data_dir: &Path) -> Vec<Job> {
    let file = path(data_dir);
    let Ok(text) = fs::read_to_string(&file) else {
        return Vec::new();
    };
    match serde_json::from_str::<File>(&text) {
        Ok(parsed) => parsed.jobs,
        Err(e) => {
            eprintln!(
                "winku: {} is invalid ({e}); starting without tasks",
                file.display()
            );
            let _ = fs::rename(&file, data_dir.join(format!("{FILE_NAME}.bad")));
            Vec::new()
        }
    }
}

/// The text `save` writes, to tell whether anything changed.
pub fn serialize(jobs: &[Job]) -> String {
    let file = File {
        version: VERSION,
        jobs: jobs.to_vec(),
    };
    serde_json::to_string_pretty(&file).unwrap_or_default()
}

/// Writes `text` (from `serialize`) through a temporary file and a rename.
pub fn save(data_dir: &Path, text: &str) -> std::io::Result<()> {
    fs::create_dir_all(data_dir)?;
    let tmp = data_dir.join(format!("{FILE_NAME}.tmp"));
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path(data_dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_800_000_000_000;

    fn timer(name: &str, at: u64) -> ScheduleParams {
        ScheduleParams {
            name: name.into(),
            prompt: format!("{name} now"),
            kind: Some(Kind::Timer),
            at: Some(at),
            ..ScheduleParams::default()
        }
    }

    fn every(name: &str, every_ms: u64) -> ScheduleParams {
        ScheduleParams {
            name: name.into(),
            prompt: "check".into(),
            kind: Some(Kind::Loop),
            every_ms: Some(every_ms),
            ..ScheduleParams::default()
        }
    }

    fn self_paced(name: &str, in_ms: u64) -> ScheduleParams {
        ScheduleParams {
            name: name.into(),
            prompt: "check".into(),
            kind: Some(Kind::Loop),
            self_paced: true,
            in_ms: Some(in_ms),
            ..ScheduleParams::default()
        }
    }

    fn watch(name: &str) -> ScheduleParams {
        ScheduleParams {
            name: name.into(),
            prompt: "say what failed".into(),
            kind: Some(Kind::Watch),
            command: Some("watch-build".into()),
            description: Some("build fails".into()),
            ..ScheduleParams::default()
        }
    }

    fn job(id: &str, kind: Kind, next: Option<u64>) -> Job {
        Job {
            id: id.into(),
            name: format!("job {id}"),
            kind,
            prompt: "p".into(),
            self_paced: false,
            every_ms: (kind == Kind::Loop).then_some(2 * MINUTE),
            command: (kind == Kind::Watch).then(|| "cmd".into()),
            description: None,
            shell: None,
            created_at: T0,
            expires_at: (kind != Kind::Timer).then_some(T0 + LIFETIME),
            next_run_at: next,
            runs: 0,
            failures: 0,
            spoken: false,
            fallback_used: false,
        }
    }

    #[test]
    fn a_timer_runs_once_on_time_and_ends() {
        let mut tasks = Tasks::default();
        let info = tasks.schedule(timer("Oven", T0 + 20 * MINUTE), T0).unwrap();
        assert_eq!(info.id.len(), 8);
        assert!(info
            .id
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_eq!(info.next_run_at, Some(T0 + 20 * MINUTE));
        assert_eq!(info.expires_at, None);
        assert_eq!(info.status, Status::Scheduled);
        assert_eq!(tasks.poll(T0 + 20 * MINUTE - 1, true), None);
        let fire = tasks.poll(T0 + 20 * MINUTE, true).unwrap();
        assert_eq!(fire.prompt_id, "task-1");
        assert_eq!(fire.text, "Oven now");
        assert_eq!(fire.run.kind, Kind::Timer);
        assert_eq!(fire.run.final_run, None);
        assert_eq!(
            tasks.list(T0 + 20 * MINUTE, false)[0].status,
            Status::Running
        );
        assert_eq!(
            tasks.list(T0 + 20 * MINUTE, true)[0].status,
            Status::Waiting
        );
        tasks.run_ended("task-1", T0 + 21 * MINUTE);
        assert!(tasks.jobs().is_empty());
    }

    #[test]
    fn due_jobs_wait_for_idle_and_run_oldest_first_one_at_a_time() {
        let mut tasks = Tasks::default();
        let late = tasks.schedule(timer("B", T0 + 2 * MINUTE), T0).unwrap();
        let early = tasks.schedule(timer("A", T0 + MINUTE), T0).unwrap();
        let now = T0 + 3 * MINUTE;
        assert_eq!(tasks.poll(now, false), None);
        assert_eq!(tasks.list(now, false)[0].status, Status::Due);
        let first = tasks.poll(now, true).unwrap();
        assert_eq!(first.run.job_id, early.id);
        assert_eq!(tasks.poll(now, true), None, "one run at a time");
        tasks.run_ended(&first.prompt_id, now);
        let second = tasks.poll(now, true).unwrap();
        assert_eq!(second.run.job_id, late.id);
        assert_eq!(second.prompt_id, "task-2");
    }

    #[test]
    fn a_timer_seen_due_on_time_waits_out_a_long_busy_spell() {
        let mut tasks = Tasks::default();
        tasks.schedule(timer("Oven", T0 + MINUTE), T0).unwrap();
        assert_eq!(tasks.poll(T0 + MINUTE, false), None);
        assert!(tasks.poll(T0 + MINUTE + 30 * MINUTE, true).is_some());
    }

    #[test]
    fn late_timers_are_dropped_with_a_notice() {
        let mut tasks = Tasks::default();
        let at = T0 + MINUTE;
        tasks.schedule(timer("Oven", at), T0).unwrap();
        // Asleep: the first tick after waking is 10 minutes and a bit late.
        assert_eq!(tasks.poll(at + LATE + 1, true), None);
        assert!(tasks.jobs().is_empty());
        assert_eq!(
            tasks.take_effects().notices,
            [format!("Missed: \"Oven\" was due at {}.", clock(at))]
        );
        // Exactly 10 minutes late still runs.
        let mut tasks = Tasks::default();
        tasks.schedule(timer("Oven", at), T0).unwrap();
        assert!(tasks.poll(at + LATE, true).is_some());
    }

    #[test]
    fn missed_fires_collapse_into_one_run() {
        let mut tasks = Tasks::default();
        let id = tasks.schedule(every("DM", 2 * MINUTE), T0).unwrap().id;
        let first = tasks.job(&id).unwrap().next_run_at.unwrap();
        // Asleep for 9 minutes past the first fire: fires at +0, +2, +4, +6, +8.
        let now = first + 9 * MINUTE;
        let fire = tasks.poll(now, true).unwrap();
        assert_eq!(fire.run.missed, Some(4));
        assert_eq!(
            tasks.job(&id).unwrap().next_run_at,
            Some(first + 10 * MINUTE),
            "stays on its cadence"
        );
        tasks.run_ended(&fire.prompt_id, now + 30 * SECOND);
        assert_eq!(tasks.job(&id).unwrap().runs, 1);
        assert_eq!(tasks.poll(now + 45 * SECOND, true), None);
        let fire = tasks.poll(first + 10 * MINUTE, true).unwrap();
        assert_eq!(fire.run.missed, None);
    }

    #[test]
    fn jitter_is_stable_and_bounded() {
        assert_eq!(jitter("00000000", 2 * MINUTE), 0);
        assert_eq!(jitter("80000000", 2 * MINUTE), 30 * SECOND);
        assert_eq!(jitter("80000000", 4 * 60 * MINUTE), 15 * MINUTE);
        let max = jitter("ffffffff", 2 * MINUTE);
        assert!(max < MINUTE && max > 59 * SECOND);
        // Capped at 30 minutes, however long the gap.
        assert!(jitter("ffffffff", 7 * DAY) < JITTER_CAP);
        assert!(jitter("ffffffff", 7 * DAY) > JITTER_CAP - SECOND);
        assert_eq!(
            jitter("3f9a2c1d", 10 * MINUTE),
            jitter("3f9a2c1d", 10 * MINUTE)
        );
        // Loops get it; timers don't.
        let mut tasks = Tasks::default();
        let info = tasks.schedule(every("DM", 2 * MINUTE), T0).unwrap();
        assert_eq!(
            info.next_run_at,
            Some(T0 + 2 * MINUTE + jitter(&info.id, 2 * MINUTE))
        );
    }

    #[test]
    fn loops_expire_with_a_final_run() {
        let mut tasks = Tasks::default();
        let id = tasks.schedule(every("DM", DAY), T0).unwrap().id;
        let expiry = T0 + LIFETIME;
        assert_eq!(tasks.job(&id).unwrap().expires_at, Some(expiry));
        let mut now = T0;
        let mut finals = 0;
        while let Some(job) = tasks.job(&id).cloned() {
            now = job.next_run_at.unwrap().min(expiry).max(now);
            let fire = tasks.poll(now, true).unwrap();
            if fire.run.final_run == Some(true) {
                finals += 1;
                assert!(now >= expiry);
            }
            tasks.run_ended(&fire.prompt_id, now + SECOND);
            now += SECOND;
        }
        assert_eq!(finals, 1);
        assert!(tasks.take_effects().notices.is_empty());
    }

    #[test]
    fn self_paced_runs_pick_the_next_time() {
        let mut tasks = Tasks::default();
        let id = tasks
            .schedule(self_paced("deploy", 5 * MINUTE), T0)
            .unwrap()
            .id;
        let first = T0 + 5 * MINUTE + jitter(&id, 5 * MINUTE);
        assert_eq!(tasks.job(&id).unwrap().next_run_at, Some(first));
        let fire = tasks.poll(first, true).unwrap();
        assert_eq!(fire.run.self_paced, Some(true));
        let info = tasks
            .wakeup(&id, Some(7 * MINUTE), false, first + SECOND)
            .unwrap()
            .unwrap();
        let next = first + SECOND + 7 * MINUTE + jitter(&id, 7 * MINUTE);
        assert_eq!(info.next_run_at, Some(next));
        // The run outlasts its own delay: the decision still stands.
        tasks.run_ended(&fire.prompt_id, first + 10 * MINUTE);
        assert_eq!(tasks.job(&id).unwrap().next_run_at, Some(next));
        assert!(!tasks.job(&id).unwrap().fallback_used);
        // stop ends it.
        let fire = tasks.poll(next, true).unwrap();
        assert_eq!(tasks.wakeup(&id, None, true, next), Ok(None));
        assert!(tasks.jobs().is_empty());
        tasks.run_ended(&fire.prompt_id, next + SECOND);
        assert!(tasks.take_effects().notices.is_empty());
    }

    #[test]
    fn self_paced_falls_back_once_then_ends() {
        let mut tasks = Tasks::default();
        let id = tasks.schedule(self_paced("deploy", MINUTE), T0).unwrap().id;
        let at = tasks.job(&id).unwrap().next_run_at.unwrap();
        let fire = tasks.poll(at, true).unwrap();
        tasks.run_ended(&fire.prompt_id, at + SECOND);
        let job = tasks.job(&id).unwrap();
        assert!(job.fallback_used);
        let fallback = at + SECOND + FALLBACK + jitter(&id, FALLBACK);
        assert_eq!(job.next_run_at, Some(fallback));
        let fire = tasks.poll(fallback, true).unwrap();
        tasks.run_ended(&fire.prompt_id, fallback + SECOND);
        assert!(tasks.jobs().is_empty());
        assert_eq!(
            tasks.take_effects().notices,
            ["\"deploy\" stopped: it didn't pick a next time."]
        );
    }

    #[test]
    fn next_wakeup_is_refused_outside_self_paced_and_on_the_final_run() {
        let mut tasks = Tasks::default();
        let loop_id = tasks.schedule(every("DM", MINUTE), T0).unwrap().id;
        let timer_id = tasks.schedule(timer("Oven", T0 + MINUTE), T0).unwrap().id;
        let paced = tasks.schedule(self_paced("deploy", MINUTE), T0).unwrap().id;
        for id in [&loop_id, &timer_id] {
            assert_eq!(
                tasks.wakeup(id, Some(MINUTE), false, T0),
                Err(NOT_SELF_PACED.into())
            );
        }
        assert_eq!(
            tasks.wakeup("00000000", Some(MINUTE), false, T0),
            Err("No task with id 00000000.".into())
        );
        for delay in [Some(59 * SECOND), Some(61 * MINUTE), None] {
            assert_eq!(
                tasks.wakeup(&paced, delay, false, T0),
                Err(BAD_DELAY.into())
            );
        }
        // The final run, after the expiry.
        let mut tasks = Tasks::restore(
            vec![Job {
                self_paced: true,
                every_ms: None,
                ..job("abcd0123", Kind::Loop, Some(T0 + LIFETIME + DAY))
            }],
            T0,
        );
        let now = T0 + LIFETIME;
        let fire = tasks.poll(now, true).unwrap();
        assert_eq!(fire.run.final_run, Some(true));
        assert_eq!(
            tasks.wakeup("abcd0123", Some(5 * MINUTE), false, now),
            Err(EXPIRED.into())
        );
        assert_eq!(
            tasks.wakeup("abcd0123", None, true, now),
            Err(EXPIRED.into())
        );
        tasks.run_ended(&fire.prompt_id, now);
        assert!(tasks.jobs().is_empty());
    }

    #[test]
    fn cancel_and_own_job_only_from_a_run() {
        let mut tasks = Tasks::default();
        let a = tasks.schedule(timer("A", T0 + MINUTE), T0).unwrap().id;
        let b = tasks.schedule(watch("B"), T0).unwrap().id;
        tasks.take_effects();
        assert_eq!(tasks.cancel(&a, Some(&b), T0), Err(ONLY_ITSELF.into()));
        assert_eq!(
            tasks.cancel("ffffffff", None, T0),
            Err("No task with id ffffffff.".into())
        );
        let info = tasks.cancel(&b, Some(&b), T0).unwrap();
        assert_eq!(info.name, "B");
        assert_eq!(info.status, Status::Watching);
        assert_eq!(tasks.take_effects().stop_watches, [b.as_str()]);
        assert_eq!(tasks.cancel(&a, None, T0).unwrap().name, "A");
        assert!(tasks.jobs().is_empty());
        // A run can't schedule.
        let mut params = timer("C", T0 + MINUTE);
        params.from = Some(a);
        assert_eq!(tasks.schedule(params, T0), Err(ONLY_ITSELF.into()));
    }

    #[test]
    fn a_job_cancelled_during_its_run_stays_gone() {
        let mut tasks = Tasks::default();
        let id = tasks.schedule(every("DM", MINUTE), T0).unwrap().id;
        let fire = tasks.poll(T0 + 2 * MINUTE, true).unwrap();
        tasks.cancel(&id, Some(&id), T0 + 2 * MINUTE).unwrap();
        tasks.run_ended(&fire.prompt_id, T0 + 3 * MINUTE);
        assert!(tasks.jobs().is_empty());
        assert_eq!(tasks.running(), None);
    }

    #[test]
    fn caps_and_errors() {
        let mut tasks = Tasks::default();
        let short = timer("x", T0 + 14 * SECOND);
        assert_eq!(tasks.schedule(short, T0), Err(TOO_SHORT.into()));
        assert_eq!(
            tasks.schedule(every("x", 14 * SECOND), T0),
            Err(TOO_SHORT.into())
        );
        assert_eq!(
            tasks.schedule(timer("x", T0 + 7 * DAY + 1), T0),
            Err(TOO_FAR.into())
        );
        assert!(tasks.schedule(timer("x", T0 + 7 * DAY), T0).is_ok());
        assert!(tasks.schedule(every("x", 15 * SECOND), T0).is_ok());
        for delay in [59 * SECOND, 61 * MINUTE] {
            assert_eq!(
                tasks.schedule(self_paced("x", delay), T0),
                Err(BAD_DELAY.into())
            );
        }
        for _ in 0..MAX_WATCHES {
            tasks.schedule(watch("w"), T0).unwrap();
        }
        assert_eq!(tasks.schedule(watch("w"), T0), Err(TOO_MANY_WATCHES.into()));
        while tasks.jobs().len() < MAX_JOBS {
            tasks.schedule(every("x", MINUTE), T0).unwrap();
        }
        assert_eq!(
            tasks.schedule(every("x", MINUTE), T0),
            Err(TOO_MANY_TASKS.into())
        );
        let ids: HashSet<_> = tasks.jobs().iter().map(|j| j.id.clone()).collect();
        assert_eq!(ids.len(), MAX_JOBS, "ids are unique");
    }

    #[test]
    fn names_are_trimmed_and_cut() {
        let mut tasks = Tasks::default();
        let long = format!("  {}  ", "é".repeat(50));
        let info = tasks.schedule(timer(&long, T0 + MINUTE), T0).unwrap();
        assert_eq!(info.name, "é".repeat(40));
        let info = tasks.schedule(timer("  Oven ", T0 + MINUTE), T0).unwrap();
        assert_eq!(info.name, "Oven");
        let info = tasks.schedule(watch("  "), T0).unwrap();
        assert_eq!(info.name, "build fails");
    }

    #[test]
    fn three_failures_in_a_row_end_a_job_and_a_success_resets() {
        let mut tasks = Tasks::default();
        let id = tasks.schedule(every("DM", MINUTE), T0).unwrap().id;
        let mut now = T0;
        let mut run = |tasks: &mut Tasks, error: Option<&str>| {
            now = tasks.job(&id).unwrap().next_run_at.unwrap();
            let fire = tasks.poll(now, true).unwrap();
            if let Some(kind) = error {
                tasks.run_error(&fire.prompt_id, kind);
            }
            tasks.run_error("someone-else", "auth");
            tasks.run_ended(&fire.prompt_id, now + SECOND);
        };
        run(&mut tasks, Some("network"));
        run(&mut tasks, Some("network"));
        assert_eq!(tasks.job(&id).unwrap().failures, 2);
        run(&mut tasks, None);
        assert_eq!(tasks.job(&id).unwrap().failures, 0);
        run(&mut tasks, Some("model"));
        run(&mut tasks, Some("network"));
        run(&mut tasks, Some("network"));
        assert!(tasks.jobs().is_empty());
        assert_eq!(
            tasks.take_effects().notices,
            ["Stopped \"DM\": the last 3 runs failed (network)."]
        );
    }

    #[test]
    fn restart_keeps_next_runs_and_gives_notices() {
        let now = T0 + DAY;
        let jobs = vec![
            // Timers: on time later, a little late (runs), very late (ends).
            job("00000001", Kind::Timer, Some(now + MINUTE)),
            job("00000002", Kind::Timer, Some(now - 5 * MINUTE)),
            job("00000003", Kind::Timer, Some(now - 2 * 60 * MINUTE)),
            // Loops: next run still ahead (kept), missed one (runs once).
            job("00000004", Kind::Loop, Some(now + MINUTE)),
            job("00000005", Kind::Loop, Some(now - 30 * MINUTE)),
            job("00000006", Kind::Watch, None),
        ];
        let mut tasks = Tasks::restore(jobs, now);
        let effects = tasks.take_effects();
        assert_eq!(
            effects.notices,
            [
                format!(
                    "Missed while Winku was closed: \"job 00000003\" was due at {}.",
                    clock(now - 2 * 60 * MINUTE)
                ),
                format!(
                    "Missed while Winku was closed: \"job 00000005\" was due at {}.",
                    clock(now - 30 * MINUTE)
                ),
                "Restarted watch \"job 00000006\".".to_string(),
            ]
        );
        assert_eq!(effects.start_watches, ["00000006"]);
        let ids: Vec<_> = tasks.jobs().iter().map(|j| j.id.as_str()).collect();
        assert_eq!(
            ids,
            ["00000001", "00000002", "00000004", "00000005", "00000006"]
        );
        assert_eq!(
            tasks.job("00000004").unwrap().next_run_at,
            Some(now + MINUTE)
        );
        // The late loop and timer run at the first idle moment, oldest first.
        let fire = tasks.poll(now + 20 * MINUTE, true).unwrap();
        assert_eq!(fire.run.job_id, "00000005");
        assert_eq!(fire.run.missed, Some(25));
        tasks.run_ended(&fire.prompt_id, now + 20 * MINUTE);
        let fire = tasks.poll(now + 20 * MINUTE, true).unwrap();
        assert_eq!(
            fire.run.job_id, "00000002",
            "seen due at restart, so it runs"
        );
    }

    #[test]
    fn watch_lines_wake_and_the_exit_ends_the_watch() {
        let mut tasks = Tasks::default();
        let id = tasks.schedule(watch("w"), T0).unwrap().id;
        assert_eq!(tasks.take_effects().start_watches, [id.as_str()]);
        tasks.watch_started(&id, T0);
        assert_eq!(tasks.list(T0, false)[0].status, Status::Watching);
        tasks.watch_line(&id, "  FAILED: test_a  ", T0 + MINUTE);
        tasks.watch_line(&id, "", T0 + MINUTE);
        assert_eq!(tasks.poll(T0 + MINUTE + 999, true), None);
        let fire = tasks.poll(T0 + MINUTE + SECOND, true).unwrap();
        assert_eq!(fire.run.description.as_deref(), Some("build fails"));
        assert_eq!(fire.run.lines, Some(vec!["FAILED: test_a".to_string()]));
        assert_eq!(fire.run.dropped, None);
        tasks.run_ended(&fire.prompt_id, T0 + 2 * MINUTE);
        assert_eq!(tasks.job(&id).unwrap().runs, 1);
        // A line, then the command exits a while later: the line runs, then the job ends.
        tasks.watch_line(&id, "FAILED: test_b", T0 + 3 * MINUTE);
        tasks.watch_exited(&id, 1, None, T0 + 3 * MINUTE);
        assert_eq!(tasks.poll(T0 + 3 * MINUTE, false), None);
        assert!(tasks.job(&id).is_some(), "lines still waiting");
        let fire = tasks.poll(T0 + 3 * MINUTE, true).unwrap();
        tasks.run_ended(&fire.prompt_id, T0 + 4 * MINUTE);
        assert_eq!(tasks.poll(T0 + 4 * MINUTE, true), None);
        assert!(tasks.jobs().is_empty());
        let effects = tasks.take_effects();
        assert_eq!(effects.notices, ["Watch \"w\" ended (exit 1)."]);
        assert_eq!(effects.stop_watches, [id]);
    }

    #[test]
    fn quick_failing_watches_restart_then_stop() {
        let mut tasks = Tasks::default();
        let id = tasks.schedule(watch("w"), T0).unwrap().id;
        tasks.take_effects();
        for n in 1..FAILURE_LIMIT {
            tasks.watch_started(&id, T0);
            tasks.watch_exited(&id, 2, Some("boom"), T0 + 9 * SECOND);
            assert_eq!(tasks.job(&id).unwrap().failures, n);
            assert_eq!(tasks.take_effects().start_watches, [id.as_str()]);
        }
        tasks.watch_started(&id, T0);
        tasks.watch_exited(&id, 2, Some("access denied\n"), T0 + SECOND);
        assert!(tasks.jobs().is_empty());
        assert_eq!(
            tasks.take_effects().notices,
            ["Stopped \"w\": the last 3 runs failed (access denied)."]
        );
    }

    #[test]
    fn expired_watches_are_killed_and_run_once_more() {
        let mut tasks = Tasks::default();
        let id = tasks.schedule(watch("w"), T0).unwrap().id;
        tasks.take_effects();
        tasks.watch_started(&id, T0);
        let expiry = T0 + LIFETIME;
        tasks.watch_line(&id, "late line", expiry - 10 * SECOND);
        assert_eq!(tasks.poll(expiry, false), None);
        assert_eq!(tasks.take_effects().stop_watches, [id.as_str()]);
        let fire = tasks.poll(expiry + MINUTE, true).unwrap();
        assert_eq!(fire.run.final_run, Some(true));
        assert_eq!(fire.run.lines, Some(vec!["late line".to_string()]));
        tasks.run_ended(&fire.prompt_id, expiry + 2 * MINUTE);
        assert!(tasks.jobs().is_empty());
    }

    #[test]
    fn line_batching() {
        let mut buffer = LineBuffer::default();
        assert_eq!(buffer.ready_since(T0), None);
        buffer.push("a", T0);
        buffer.push("b", T0 + 500);
        assert_eq!(buffer.ready_since(T0 + 1400), None, "burst still open");
        assert_eq!(buffer.ready_since(T0 + 1500), Some(T0 + 1500));
        let (lines, dropped) = buffer.take(T0 + 2000);
        assert_eq!((lines, dropped), (vec!["a".into(), "b".into()], 0));
        // The next wake waits out the 15 s limit.
        buffer.push("c", T0 + 3000);
        assert_eq!(buffer.ready_since(T0 + 16_999), None);
        assert_eq!(buffer.ready_since(T0 + 17_000), Some(T0 + 17_000));
        buffer.take(T0 + 17_000);
        // A burst that never pauses still wakes after 15 s.
        let start = T0 + 60_000;
        for n in 0..40 {
            buffer.push(&format!("{n}"), start + n * 500);
        }
        assert_eq!(buffer.ready_since(start + 15_000), Some(start + 15_000));
        // 50 kept, older ones dropped and counted; lines are cut at 500 characters.
        let mut buffer = LineBuffer::default();
        for n in 0..60 {
            buffer.push(&format!("line {n}"), T0);
        }
        buffer.push(&"x".repeat(600), T0);
        let (lines, dropped) = buffer.take(T0 + SECOND);
        assert_eq!(lines.len(), LINES_KEPT);
        assert_eq!(dropped, 11);
        assert_eq!(lines[0], "line 11");
        assert_eq!(lines[49].len(), LINE_CAP);
        assert!(buffer.is_empty());
    }

    #[test]
    fn file_round_trips_and_a_bad_file_is_moved_aside() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load(dir.path()).is_empty());
        let mut tasks = Tasks::default();
        tasks.schedule(every("DM", MINUTE), T0).unwrap();
        let mut params = watch("w");
        params.shell = Some(WatchShell {
            kind: "bash".into(),
            path: Some("/usr/bin/bash".into()),
        });
        tasks.schedule(params, T0).unwrap();
        save(dir.path(), &serialize(tasks.jobs())).unwrap();
        assert!(!dir.path().join("tasks.json.tmp").exists());
        assert_eq!(load(dir.path()), tasks.jobs());
        let text = fs::read_to_string(path(dir.path())).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["version"], 1);
        let job = &value["jobs"][0];
        for key in [
            "id",
            "name",
            "kind",
            "prompt",
            "selfPaced",
            "everyMs",
            "createdAt",
            "expiresAt",
            "nextRunAt",
            "runs",
            "failures",
            "spoken",
            "fallbackUsed",
        ] {
            assert!(job.get(key).is_some(), "{key}");
        }
        assert_eq!(value["jobs"][1]["shell"]["kind"], "bash");
        fs::write(path(dir.path()), "{ nope").unwrap();
        assert!(load(dir.path()).is_empty());
        assert!(dir.path().join("tasks.json.bad").exists());
    }

    #[test]
    fn json_shapes_match_the_protocol() {
        let mut tasks = Tasks::default();
        let info = tasks.schedule(every("DM", MINUTE), T0).unwrap();
        let value = serde_json::to_value(&info).unwrap();
        assert_eq!(value["kind"], "loop");
        assert_eq!(value["status"], "scheduled");
        assert_eq!(value["selfPaced"], false);
        assert_eq!(value["everyMs"], MINUTE);
        assert!(value.get("description").is_none());
        let fire = tasks.poll(T0 + 10 * MINUTE, true).unwrap();
        let run = serde_json::to_value(&fire.run).unwrap();
        assert_eq!(run["jobId"], info.id);
        assert!(run.get("final").is_none());
        assert!(run["missed"].as_u64().unwrap() > 0);
        let params: ScheduleParams = serde_json::from_value(serde_json::json!({
            "name": "w", "prompt": "p", "kind": "watch", "command": "c",
            "shell": { "kind": "powershell" }, "spoken": true, "from": "abc"
        }))
        .unwrap();
        assert_eq!(params.kind, Some(Kind::Watch));
        assert_eq!(params.from.as_deref(), Some("abc"));
        assert!(params.spoken);
    }
}
