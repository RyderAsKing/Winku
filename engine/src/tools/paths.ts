import { isAbsolute, join, resolve } from "node:path";

/** Resolve a path the way the tools see it: `~` is the home folder, relative paths start there. */
export function resolveFromHome(path: string, home: string): string {
	let p = path.trim();
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") return home;
	if (p.startsWith("~/") || p.startsWith("~\\")) p = join(home, p.slice(2));
	return isAbsolute(p) ? resolve(p) : resolve(home, p);
}
