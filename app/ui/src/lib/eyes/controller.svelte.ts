// Decides what the eyes show. Activity comes from the engine and hotkeys; moods and the
// cleared look are short transients; sleep comes from inactivity.
//
// Motion budget (SPEC §4): continuous loops and idle blinks/glances run only while the bar
// is showing. With the bar hidden or the eyes asleep everything is still, so the resting pill
// costs nothing. One-off reactions (noted, yawn, wipe) still play because they mark events.
import type { Mood } from "../../../../../engine/src/protocol.ts";
import type { EyeState } from "./look.ts";

export type Activity = "idle" | "listening" | "thinking" | "speaking" | "error";
type Transient = "happy" | "hearts" | "cleared";

interface EyeHandle {
	blink(): void;
	glance(): void;
	noted(): void;
	yawn(): void;
	wipe(): void;
}

const SLEEP_AFTER_MS = 10 * 60_000;

export class EyeController {
	activity: Activity = $state("idle");
	transient: Transient | null = $state(null);
	sleeping = $state(false);
	barVisible = $state(false);
	reduceMotion = $state(false);

	readonly state: EyeState = $derived(this.sleeping ? "sleeping" : (this.transient ?? this.activity));
	/** Continuous loops allowed right now. */
	readonly animate: boolean = $derived(this.barVisible && !this.sleeping && !this.reduceMotion);

	#handle: EyeHandle | undefined;
	#transientTimer: ReturnType<typeof setTimeout> | undefined;
	#sleepTimer: ReturnType<typeof setTimeout> | undefined;
	#idleTimer: ReturnType<typeof setTimeout> | undefined;
	#errorTimer: ReturnType<typeof setTimeout> | undefined;

	constructor() {
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		this.reduceMotion = query.matches;
		query.addEventListener("change", (e) => {
			this.reduceMotion = e.matches;
		});
		this.touch();
	}

	attach(handle: EyeHandle | undefined) {
		this.#handle = handle;
	}

	/** Any user interaction: wakes the eyes and restarts the sleep timer. */
	touch() {
		this.sleeping = false;
		clearTimeout(this.#sleepTimer);
		this.#sleepTimer = setTimeout(() => {
			if (this.activity === "idle") this.sleeping = true;
		}, SLEEP_AFTER_MS);
	}

	setBarVisible(visible: boolean) {
		this.barVisible = visible;
		this.#scheduleIdle();
	}

	setActivity(activity: Activity) {
		if (activity !== "idle") this.touch();
		if (activity !== "error") clearTimeout(this.#errorTimer);
		this.activity = activity;
		if (activity !== "idle") this.#clearTransient();
		this.#scheduleIdle();
	}

	/** Errors are shown for a while, then the eyes recover on their own. */
	error() {
		this.setActivity("error");
		this.#errorTimer = setTimeout(() => {
			if (this.activity === "error") this.setActivity("idle");
		}, 6000);
	}

	/** A reply finished. Mood tag if the model gave one, else a short happy look (SPEC §4). */
	replyFinished(mood: Mood | undefined, userSaidThanks: boolean) {
		this.setActivity("idle");
		if (mood === "hearts" || (mood === undefined && userSaidThanks)) this.#flash("hearts", 2600);
		else if (mood === undefined || mood === "happy") this.#flash("happy", 2000);
	}

	cleared() {
		this.touch();
		this.#handle?.wipe();
		this.#flash("cleared", 1600);
	}

	noted() {
		this.#handle?.noted();
	}

	yawn() {
		this.#handle?.yawn();
	}

	#flash(transient: Transient, ms: number) {
		clearTimeout(this.#transientTimer);
		this.transient = transient;
		this.#transientTimer = setTimeout(() => {
			this.transient = null;
		}, ms);
	}

	#clearTransient() {
		clearTimeout(this.#transientTimer);
		this.transient = null;
	}

	/** Occasional slow blink or glance while idle with the bar showing. One-off timers, no loops. */
	#scheduleIdle() {
		clearTimeout(this.#idleTimer);
		if (!this.barVisible || this.sleeping || this.reduceMotion || this.state !== "idle") return;
		this.#idleTimer = setTimeout(
			() => {
				if (Math.random() < 0.75) this.#handle?.blink();
				else this.#handle?.glance();
				this.#scheduleIdle();
			},
			5000 + Math.random() * 7000,
		);
	}
}

export function saysThanks(text: string): boolean {
	return /\b(thanks|thank you|thx|ty|cheers|much appreciated)\b/i.test(text);
}
