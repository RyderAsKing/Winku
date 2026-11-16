// The memory map (Settings > Memory and voice > Notes > Map): each topic is a hub, its notes hang
// off it, and notes in different topics that mean similar things are linked (memory_map). The
// layout is a small force simulation run to rest before anything is drawn, so nothing drifts on
// screen; positions carry over between reloads so the map doesn't rearrange when one note changes.

import type { MemoryLink, MemoryOverview } from "../../../../engine/src/protocol.ts";

export type MapNote = MemoryOverview["notes"][number];

export interface MapNode {
	/** "topic:<name>" for a hub, "note:<topic>/<id>" for a note. */
	key: string;
	kind: "topic" | "note";
	label: string;
	/** Hubs: how many notes they hold. Notes: 1. */
	size: number;
	note?: MapNote;
	x: number;
	y: number;
}

export interface MapEdge {
	a: string;
	b: string;
	/** "topic" joins a note to its hub; "meaning" joins notes that mean similar things. */
	kind: "topic" | "meaning";
	similarity?: number;
}

export interface MapGraph {
	nodes: MapNode[];
	edges: MapEdge[];
}

export const topicKey = (topic: string) => `topic:${topic}`;
export const noteKey = (note: Pick<MapNote, "topic" | "id">) => `note:${note.topic}/${note.id}`;

/** The graph for some notes and their links. Links to notes that aren't in the list are dropped. */
export function buildGraph(notes: MapNote[], links: MemoryLink[]): MapGraph {
	const byId = new Map(notes.map((n) => [n.id, n]));
	const counts = new Map<string, number>();
	for (const n of notes) counts.set(n.topic, (counts.get(n.topic) ?? 0) + 1);
	const nodes: MapNode[] = [
		...[...counts]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([topic, size]) => ({
				key: topicKey(topic),
				kind: "topic" as const,
				label: topic,
				size,
				x: 0,
				y: 0,
			})),
		...notes.map((note) => ({
			key: noteKey(note),
			kind: "note" as const,
			label: note.title,
			size: 1,
			note,
			x: 0,
			y: 0,
		})),
	];
	const edges: MapEdge[] = notes.map((note) => ({
		a: topicKey(note.topic),
		b: noteKey(note),
		kind: "topic",
	}));
	for (const link of links) {
		const a = byId.get(link.a);
		const b = byId.get(link.b);
		if (a && b)
			edges.push({
				a: noteKey(a),
				b: noteKey(b),
				kind: "meaning",
				similarity: link.similarity,
			});
	}
	return { nodes, edges };
}

const TOPIC_LENGTH = 46;
const MEANING_LENGTH = 110;
const REPEL = 900;

/**
 * Place the nodes. Nodes found in `previous` keep their place; if every node has one, nothing moves.
 * New nodes start beside their hub (or on a ring, for new hubs) and the simulation settles them.
 */
export function layout(graph: MapGraph, previous: ReadonlyMap<string, { x: number; y: number }> = new Map()): MapGraph {
	const nodes = graph.nodes.map((n) => ({ ...n }));
	const index = new Map(nodes.map((n, i) => [n.key, i]));
	const fresh = nodes.filter((n) => !previous.has(n.key));
	const topics = nodes.filter((n) => n.kind === "topic");
	const ring = 70 * Math.sqrt(topics.length);
	topics.forEach((n, i) => {
		const angle = (i / Math.max(1, topics.length)) * Math.PI * 2;
		const kept = previous.get(n.key);
		n.x = kept?.x ?? Math.cos(angle) * ring;
		n.y = kept?.y ?? Math.sin(angle) * ring;
	});
	let spoke = 0;
	for (const n of nodes) {
		if (n.kind !== "note") continue;
		const kept = previous.get(n.key);
		const hub = nodes[index.get(topicKey(n.note?.topic ?? "")) ?? -1];
		// The golden angle spreads siblings evenly without any randomness.
		const angle = spoke++ * 2.399963;
		n.x = kept?.x ?? (hub?.x ?? 0) + Math.cos(angle) * TOPIC_LENGTH;
		n.y = kept?.y ?? (hub?.y ?? 0) + Math.sin(angle) * TOPIC_LENGTH;
	}
	if (fresh.length === 0) return { nodes, edges: graph.edges };

	const pinned = new Set(previous.size ? nodes.filter((n) => previous.has(n.key)).map((n) => n.key) : []);
	const edges = graph.edges.flatMap((e) => {
		const a = index.get(e.a);
		const b = index.get(e.b);
		return a === undefined || b === undefined
			? []
			: [
					{
						a,
						b,
						length: e.kind === "topic" ? TOPIC_LENGTH : MEANING_LENGTH,
						strength: e.kind === "topic" ? 0.5 : 0.06 + 0.2 * Math.max(0, (e.similarity ?? 0.3) - 0.3),
					},
				];
	});
	const vx = new Float64Array(nodes.length);
	const vy = new Float64Array(nodes.length);
	const ticks = nodes.length > 400 ? 160 : 300;
	for (let t = 0; t < ticks; t++) {
		const alpha = 1 - t / ticks;
		for (let i = 0; i < nodes.length; i++) {
			const a = nodes[i] as MapNode;
			for (let j = i + 1; j < nodes.length; j++) {
				const b = nodes[j] as MapNode;
				let dx = b.x - a.x;
				let dy = b.y - a.y;
				let d2 = dx * dx + dy * dy;
				if (d2 < 1e-4) {
					dx = ((i * 7 + j * 13) % 11) - 5 || 1;
					dy = ((i * 5 + j * 3) % 7) - 3 || 1;
					d2 = dx * dx + dy * dy;
				}
				const weight = (a.kind === "topic" ? 3 : 1) * (b.kind === "topic" ? 3 : 1);
				const force = (REPEL * weight * alpha) / Math.max(d2, 64);
				const d = Math.sqrt(d2);
				vx[i] = (vx[i] ?? 0) - (dx / d) * force;
				vy[i] = (vy[i] ?? 0) - (dy / d) * force;
				vx[j] = (vx[j] ?? 0) + (dx / d) * force;
				vy[j] = (vy[j] ?? 0) + (dy / d) * force;
			}
		}
		for (const e of edges) {
			const a = nodes[e.a] as MapNode;
			const b = nodes[e.b] as MapNode;
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const d = Math.hypot(dx, dy) || 1;
			const pull = ((d - e.length) / d) * e.strength * alpha;
			vx[e.a] = (vx[e.a] ?? 0) + dx * pull;
			vy[e.a] = (vy[e.a] ?? 0) + dy * pull;
			vx[e.b] = (vx[e.b] ?? 0) - dx * pull;
			vy[e.b] = (vy[e.b] ?? 0) - dy * pull;
		}
		for (let i = 0; i < nodes.length; i++) {
			const n = nodes[i] as MapNode;
			if (pinned.has(n.key)) {
				vx[i] = 0;
				vy[i] = 0;
				continue;
			}
			// A gentle pull to the middle keeps separate topics from drifting apart forever.
			vx[i] = ((vx[i] ?? 0) - n.x * 0.004 * alpha) * 0.6;
			vy[i] = ((vy[i] ?? 0) - n.y * 0.004 * alpha) * 0.6;
			n.x += vx[i] ?? 0;
			n.y += vy[i] ?? 0;
		}
	}
	return { nodes, edges: graph.edges };
}

export interface View {
	x: number;
	y: number;
	scale: number;
}

/** The view that fits every node into a `width` × `height` box with `pad` px to spare. */
export function fitView(nodes: readonly MapNode[], width: number, height: number, pad = 48): View {
	if (nodes.length === 0) return { x: width / 2, y: height / 2, scale: 1 };
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const n of nodes) {
		minX = Math.min(minX, n.x);
		minY = Math.min(minY, n.y);
		maxX = Math.max(maxX, n.x);
		maxY = Math.max(maxY, n.y);
	}
	const scale = Math.min(2, Math.max(0.2, Math.min((width - pad * 2) / Math.max(1, maxX - minX), (height - pad * 2) / Math.max(1, maxY - minY))));
	return {
		x: width / 2 - ((minX + maxX) / 2) * scale,
		y: height / 2 - ((minY + maxY) / 2) * scale,
		scale,
	};
}

/** Radius on screen at scale 1: hubs grow with their notes, important notes are a little larger. */
export function radius(node: MapNode): number {
	if (node.kind === "topic") return Math.min(14, 5 + Math.sqrt(node.size) * 2);
	return node.note?.important ? 4.5 : 3.5;
}

/** The node under a point in map coordinates, nearest first, within `slop` map px of its edge. */
export function hit(nodes: readonly MapNode[], x: number, y: number, slop: number): MapNode | undefined {
	let best: MapNode | undefined;
	let bestD = Infinity;
	for (const n of nodes) {
		const d = Math.hypot(n.x - x, n.y - y) - radius(n);
		if (d <= slop && d < bestD) {
			best = n;
			bestD = d;
		}
	}
	return best;
}

/** Each node's neighbours, both ways. */
export function neighbours(edges: readonly MapEdge[]): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	const add = (a: string, b: string) => {
		let set = out.get(a);
		if (!set) out.set(a, (set = new Set()));
		set.add(b);
	};
	for (const e of edges) {
		add(e.a, e.b);
		add(e.b, e.a);
	}
	return out;
}
