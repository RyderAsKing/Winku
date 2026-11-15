import { describe, expect, test } from "bun:test";
import { alphaFor, BURST_MS, burstField, type DotBurst, dotBurstFor, dotLoopFor, type Field, loopField, noise, PITCH, quiet, UNDER_TEXT } from "../src/lib/eyes/dots.ts";

const bar: Field = { length: 434, half: 28, level: 0.6, strength: 1 };
const pill: Field = { length: 46, half: 28, level: 0.6, strength: 0.5 };
const bursts = Object.keys(BURST_MS) as DotBurst[];

/** Every dot of a face, as offsets from the eyes. */
function grid(f: Field) {
	const dots: [number, number][] = [];
	for (let ax = -40; ax <= f.length; ax += PITCH) for (let ay = -f.half; ay <= f.half; ay += PITCH) dots.push([ax, ay]);
	return dots;
}

describe("dot field", () => {
	test.each(bursts)("%s stays 0…1 and is dark again when it ends", (kind) => {
		for (const f of [bar, pill]) {
			for (const p of [0, 0.25, 0.5, 0.75]) for (const [ax, ay] of grid(f)) {
				const b = burstField(kind, ax, ay, p, f);
				expect(b).toBeGreaterThanOrEqual(0);
				expect(b).toBeLessThanOrEqual(1);
			}
			for (const [ax, ay] of grid(f)) expect(burstField(kind, ax, ay, 1, f)).toBeCloseTo(0, 2);
		}
	});

	test.each(bursts)("%s lights something on the way", (kind) => {
		const lit = [0.15, 0.3, 0.5].some((p) => grid(bar).some(([ax, ay]) => burstField(kind, ax, ay, p, bar) > 0.2));
		expect(lit).toBe(true);
	});

	test.each(["listening", "thinking", "speaking"] as const)("%s stays 0…1 and is brightest by the eyes", (kind) => {
		let near = 0;
		let far = 0;
		for (const t of [0, 0.4, 0.9, 1.7]) for (const [ax, ay] of grid(bar)) {
			const b = loopField(kind, ax, ay, t, bar);
			expect(b).toBeGreaterThanOrEqual(0);
			expect(b).toBeLessThanOrEqual(1);
			if (ax < bar.length / 3) near += b;
			else if (ax > (bar.length * 2) / 3) far += b;
		}
		expect(near).toBeGreaterThan(far);
	});

	test("listening grows with the voice", () => {
		const sum = (level: number) => grid(bar).reduce((n, [ax, ay]) => n + loopField("listening", ax, ay, 0.5, { ...bar, level }), 0);
		expect(sum(1)).toBeGreaterThan(sum(0));
	});

	test("a higher thinking level sweeps further", () => {
		const reach = (strength: number) => Math.max(...grid(bar).filter(([ax, ay]) => burstField("level", ax, ay, 0.6, { ...bar, strength }) > 0.1).map(([ax]) => ax));
		expect(reach(1)).toBeGreaterThan(reach(0));
	});

	test("noise is smooth and repeatable", () => {
		expect(noise(3.2, 1.7)).toBe(noise(3.2, 1.7));
		expect(Math.abs(noise(3.2, 1.7) - noise(3.21, 1.7))).toBeLessThan(0.05);
	});

	test("loops while working, bursts for moods; nothing at idle", () => {
		expect(dotLoopFor("thinking")).toBe("thinking");
		expect(dotLoopFor("idle")).toBeNull();
		expect(dotLoopFor("sleeping")).toBeNull();
		expect(dotBurstFor("error")).toBe("error");
		expect(dotBurstFor("idle")).toBeNull();
		expect(dotBurstFor("pondering")).toBeNull();
	});

	test("under the text the dots stay dim, around the eyes they may shine", () => {
		expect(quiet(-10, 46)).toBe(1);
		expect(quiet(30, 46)).toBe(1);
		expect(quiet(60, 46)).toBeCloseTo(UNDER_TEXT);
		expect(quiet(300, 46)).toBeCloseTo(UNDER_TEXT);
	});

	test("the faintest text in the bar still reads 4.5:1 over the brightest dot under it", () => {
		const lum = (hex: string) => {
			const [r, g, b] = [1, 3, 5].map((i) => {
				const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
				return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
		};
		const mix = (a: string, b: string, t: number) =>
			`#${[1, 3, 5].map((i) => Math.round(Number.parseInt(a.slice(i, i + 2), 16) * (1 - t) + Number.parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, "0")).join("")}`;
		// The face's darkest tone under the palest dot colour the eyes use (cleared), at the most a
		// dot shows under text; --faint text over it.
		const behind = mix("#07080c", "#E7FFFB", alphaFor(UNDER_TEXT));
		const ratio = (lum("#979daa") + 0.05) / (lum(behind) + 0.05);
		expect(ratio).toBeGreaterThanOrEqual(4.5);
	});
});
