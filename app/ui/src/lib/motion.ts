// Svelte transitions run as Web Animations, which the CSS "reduce motion" rule in theme.css
// doesn't reach. Pass their durations through here so they follow the OS setting too.
const query = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

/** `duration` ms, or 0 when the OS asks for reduced motion. */
export function ms(duration: number): number {
	return query?.matches ? 0 : duration;
}

/** A little past 1 and back: the settle at the end of a pop. */
export function backOut(t: number): number {
	const s = 1.4;
	const u = t - 1;
	return u * u * ((s + 1) * u + s) + 1;
}

/**
 * A bubble arriving: it fades in while it rises `y` px into place and grows the last few percent,
 * from the corner nearest the eyes (set `transform-origin` on the node).
 */
export function pop(_node: Element, { y = 0, duration = 220, delay = 0, from = 0.96 }: { y?: number; duration?: number; delay?: number; from?: number } = {}) {
	return {
		duration: ms(duration),
		delay: ms(delay),
		css: (t: number) => {
			const e = backOut(t);
			return `opacity: ${Math.min(1, t * 1.6)}; transform: translateY(${(1 - e) * y}px) scale(${from + (1 - from) * e});`;
		},
	};
}
