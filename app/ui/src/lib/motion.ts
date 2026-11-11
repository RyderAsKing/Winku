// Svelte transitions run as Web Animations, which the CSS "reduce motion" rule in theme.css
// doesn't reach. Pass their durations through here so they follow the OS setting too.
const query = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

/** `duration` ms, or 0 when the OS asks for reduced motion. */
export function ms(duration: number): number {
	return query?.matches ? 0 : duration;
}
