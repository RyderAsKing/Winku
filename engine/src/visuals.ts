// A visual's identity (SPEC §3 Visuals): a 16-hex id, and its page at visuals\<id>.html in the data folder.
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export function newVisualId(): string {
	return randomBytes(8).toString("hex");
}

export function isVisualId(id: unknown): id is string {
	return typeof id === "string" && /^[0-9a-f]{16}$/.test(id);
}

export function visualsDir(dataDir: string): string {
	return join(dataDir, "visuals");
}

export function visualPath(dataDir: string, id: string): string {
	return join(visualsDir(dataDir), `${id}.html`);
}
