// agent-desktop envelopes → short text for the model. Pure functions.
import type { Disposition, Envelope } from "./cli.ts";

export interface TreeNode {
	ref_id?: string;
	role?: string;
	name?: string;
	value?: string;
	description?: string;
	states?: string[];
	children_count?: number;
	subtree_truncated?: boolean;
	children?: TreeNode[];
}

export interface SnapshotData {
	app?: string;
	window?: { id?: string; title?: string };
	snapshot_id?: string;
	ref_count?: number;
	complete?: boolean;
	truncated?: boolean;
	identity_unproven?: boolean;
	tree?: TreeNode;
}

export interface WindowRow {
	id: string;
	title?: string;
	app_name?: string;
	pid?: number;
	is_focused?: boolean;
	accessible?: boolean;
	[key: string]: unknown;
}

/** States that are true of nearly everything and only cost tokens. */
const QUIET_STATES = new Set(["enabled", "visible", "focusable", "selectable", "readonly_unknown"]);
const NAME_CAP = 80;
const VALUE_CAP = 160;

export function clip(text: string, max: number): string {
	const one = text.replace(/\s*\r?\n\s*/g, " ⏎ ").trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const quote = (text: string, max: number) => JSON.stringify(clip(text, max));

/** One line per node: `role "name" @ref value="…" [states] (N more inside)`. */
function nodeLine(node: TreeNode): string | undefined {
	const parts: string[] = [node.role || "element"];
	if (node.name) parts.push(quote(node.name, NAME_CAP));
	if (node.ref_id) parts.push(node.ref_id);
	if (node.value && node.value !== node.name) parts.push(`value=${quote(node.value, VALUE_CAP)}`);
	const states = (node.states ?? []).filter((s) => !QUIET_STATES.has(s));
	if (states.length) parts.push(`[${states.join(", ")}]`);
	if (node.children_count) parts.push(`(${node.children_count} more inside)`);
	else if (node.subtree_truncated && !node.children?.length) parts.push("(more inside)");
	// An unnamed leaf with nothing to act on says nothing.
	if (!node.name && !node.ref_id && !node.value && !node.children?.length && !node.children_count) return undefined;
	return parts.join(" ");
}

export interface Outline {
	text: string;
	/** Lines left out because of the cap. */
	cut: number;
	/** ref → its line's label, for permission summaries. */
	labels: Map<string, string>;
}

/** The tree as an indented outline, at most `cap` characters. */
export function outline(tree: TreeNode | undefined, cap: number): Outline {
	const lines: string[] = [];
	const labels = new Map<string, string>();
	let size = 0;
	let cut = 0;
	const walk = (node: TreeNode, depth: number) => {
		const line = nodeLine(node);
		let childDepth = depth;
		if (line) {
			const text = `${"  ".repeat(depth)}${line}`;
			if (node.ref_id) labels.set(node.ref_id, `${node.role || "element"}${node.name ? ` ${quote(node.name, 40)}` : ""}`);
			if (size + text.length + 1 > cap) cut++;
			else {
				lines.push(text);
				size += text.length + 1;
			}
			childDepth = depth + 1;
		}
		for (const child of node.children ?? []) walk(child, childDepth);
	};
	if (tree) walk(tree, 0);
	return { text: lines.join("\n"), cut, labels };
}

export function renderSnapshot(data: SnapshotData, cap: number, drill = false): Outline & { header: string } {
	const tree = outline(data.tree, cap);
	const where = [
		data.window?.id ? `window ${data.window.id}` : "",
		data.window?.title ? JSON.stringify(clip(data.window.title, 120)) : "",
		data.app ? `(${data.app})` : "",
	]
		.filter(Boolean)
		.join(" ");
	const header = `${drill ? "Drill-in of" : "Snapshot of"} ${where || "the window"}, snapshot ${data.snapshot_id ?? "?"}, ${data.ref_count ?? 0} refs.`;
	const notes: string[] = [];
	if (data.complete === false) notes.push("The app didn't answer in time, so this tree is partial; observe again to finish it.");
	if (data.identity_unproven) notes.push("Refs here may be refused (identity unproven); observe again before acting.");
	if (tree.cut)
		notes.push(
			`${tree.cut} more lines were cut to keep this short. Drill into a container with root=<its ref>, or wait for a specific element.`,
		);
	const text = [header, tree.text || "(nothing readable)", ...notes].join("\n");
	return { ...tree, header, text };
}

export function renderWindows(rows: WindowRow[]): string {
	if (!rows.length) return "No windows.";
	return rows
		.map((w) => {
			const flags = [w.is_focused ? "focused" : "", w.accessible === false ? "not accessible" : ""].filter(Boolean);
			return `${w.id} ${w.app_name ?? "?"}: ${JSON.stringify(clip(w.title ?? "", 100))}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
		})
		.join("\n");
}

/** What retry means, in the model's terms. */
function dispositionLine(disposition: Disposition | undefined): string {
	if (!disposition?.delivery) return "";
	const safe = disposition.retry === "safe";
	const what: Record<string, string> = {
		delivered_verified: "It landed and the result was checked.",
		delivered_unverified: "It was sent but the effect wasn't confirmed: observe to check before doing it again.",
		not_delivered: "Nothing was sent.",
	};
	const base = what[disposition.delivery] ?? `Delivery: ${disposition.delivery}.`;
	return `${base}${safe ? "" : " Do not repeat it blindly."}`;
}

interface ActionData {
	action?: string;
	disposition?: Disposition;
	post_state?: Record<string, unknown>;
	surfaces?: unknown[];
	details?: Record<string, unknown>;
}

export function renderAction(label: string, envelope: Envelope): string {
	const data = (envelope.data ?? {}) as ActionData;
	const lines = [`${label}: done.`, dispositionLine(data.disposition)];
	const post = data.post_state;
	if (post && typeof post === "object") {
		const bits = Object.entries(post)
			.filter(([, v]) => v !== null && v !== undefined && v !== "")
			.map(([k, v]) => `${k}=${typeof v === "string" ? quote(v, VALUE_CAP) : JSON.stringify(v)}`);
		if (bits.length) lines.push(`After: ${clip(bits.join(", "), 400)}`);
	}
	if (Array.isArray(data.surfaces) && data.surfaces.length)
		lines.push(
			`Open now: ${clip(JSON.stringify(data.surfaces), 300)}. Observe it (surface "menu" or "sheet") before acting on the window again.`,
		);
	return lines.filter(Boolean).join("\n");
}

const RECOVERY: Record<string, string> = {
	STALE_REF: "The element changed or is gone. Observe again and use the new ref.",
	SNAPSHOT_NOT_FOUND: "That snapshot expired. Observe again.",
	AMBIGUOUS_TARGET: "The ref isn't unique in the window. Pick a different, unique control, or observe again.",
	ELEMENT_NOT_FOUND: "Observe again.",
	WINDOW_NOT_FOUND: "That window is gone. List windows to find it again.",
	APP_NOT_FOUND: "That app isn't running.",
	POLICY_DENIED: "This needs a different action (or isn't allowed).",
	ACTION_NOT_SUPPORTED: "This element can't do that. Try another action or element.",
	PERM_DENIED: "Permission denied. On Windows this usually means the app runs as administrator and Winku doesn't.",
	APP_UNRESPONSIVE: "The app isn't responding. Observe again before trying anything else.",
};

/** An error envelope as advice: what failed, whether retrying is safe, what to do. */
export function renderError(label: string, envelope: Envelope): string {
	const error = envelope.error ?? { code: "INTERNAL", message: "unknown error" };
	const lines = [`${label} failed: ${error.code}: ${clip(error.message, 300)}`];
	const kind = typeof error.details?.kind === "string" ? error.details.kind : "";
	if (kind) lines.push(`Kind: ${kind}`);
	if (error.suggestion) lines.push(`Suggestion: ${clip(error.suggestion, 300)}`);
	const post = error.details?.post_state;
	if (post) lines.push(`State now: ${clip(JSON.stringify(post), 300)}`);
	const disposition = error.disposition;
	if (disposition?.retry === "safe") lines.push("Nothing was sent, so retrying is safe.");
	else if (disposition?.delivery) lines.push(`${dispositionLine(disposition)} Observe first and decide from what you see.`);
	const recovery = RECOVERY[error.code];
	if (recovery) lines.push(recovery);
	return lines.join("\n");
}
