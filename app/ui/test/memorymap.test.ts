import { expect, test } from "bun:test";
import { buildGraph, fitView, hit, layout, type MapNote, neighbours, noteKey, topicKey } from "../src/lib/memorymap.ts";

const note = (id: string, topic: string, title = id): MapNote => ({ id, topic, title, date: 0, preview: "", important: false });
const notes = [note("a", "food"), note("b", "food"), note("c", "work"), note("d", "pets")];
const links = [
	{ a: "a", b: "c", similarity: 0.7 },
	{ a: "c", b: "gone", similarity: 0.9 },
];

test("each topic is a hub, notes hang off it, and links to missing notes are dropped", () => {
	const graph = buildGraph(notes, links);
	expect(graph.nodes.filter((n) => n.kind === "topic").map((n) => [n.label, n.size])).toEqual([
		["food", 2],
		["pets", 1],
		["work", 1],
	]);
	expect(graph.edges.filter((e) => e.kind === "topic")).toHaveLength(4);
	expect(graph.edges.filter((e) => e.kind === "meaning")).toEqual([{ a: noteKey(note("a", "food")), b: noteKey(note("c", "work")), kind: "meaning", similarity: 0.7 }]);
	expect(neighbours(graph.edges).get(topicKey("food"))).toEqual(new Set([noteKey(note("a", "food")), noteKey(note("b", "food"))]));
});

test("the layout settles the same way every time, keeps notes near their hub and nodes apart", () => {
	const one = layout(buildGraph(notes, links));
	const two = layout(buildGraph(notes, links));
	expect(one.nodes.map((n) => [n.x, n.y])).toEqual(two.nodes.map((n) => [n.x, n.y]));
	const at = new Map(one.nodes.map((n) => [n.key, n]));
	for (const n of one.nodes) {
		expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
		if (n.kind !== "note" || !n.note) continue;
		const hub = at.get(topicKey(n.note.topic));
		expect(Math.hypot(n.x - (hub?.x ?? 0), n.y - (hub?.y ?? 0))).toBeLessThan(120);
	}
	for (const a of one.nodes) for (const b of one.nodes) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(8);
});

test("placed nodes stay put; a new note settles in without moving them", () => {
	const first = layout(buildGraph(notes, links));
	const placed = new Map(first.nodes.map((n) => [n.key, { x: n.x, y: n.y }]));
	const again = layout(buildGraph(notes, links), placed);
	expect(again.nodes.map((n) => [n.x, n.y])).toEqual(first.nodes.map((n) => [n.x, n.y]));
	const grown = layout(buildGraph([...notes, note("e", "food")], links), placed);
	for (const n of grown.nodes) {
		const before = placed.get(n.key);
		if (before) expect([n.x, n.y]).toEqual([before.x, before.y]);
	}
	expect(grown.nodes.find((n) => n.key === noteKey(note("e", "food")))).toBeDefined();
});

test("fit puts every node inside the box, and hit finds the dot under the pointer", () => {
	const { nodes } = layout(buildGraph(notes, links));
	const view = fitView(nodes, 600, 400);
	for (const n of nodes) {
		const x = view.x + n.x * view.scale;
		const y = view.y + n.y * view.scale;
		expect(x).toBeGreaterThanOrEqual(0);
		expect(x).toBeLessThanOrEqual(600);
		expect(y).toBeGreaterThanOrEqual(0);
		expect(y).toBeLessThanOrEqual(400);
	}
	const target = nodes.find((n) => n.kind === "note");
	expect(hit(nodes, (target?.x ?? 0) + 1, target?.y ?? 0, 2)?.key).toBe(target?.key);
	expect(hit(nodes, 10_000, 10_000, 2)).toBeUndefined();
});

test("a few hundred notes lay out quickly", () => {
	const many = Array.from({ length: 400 }, (_, i) => note(`n${i}`, `topic${i % 20}`));
	const started = performance.now();
	layout(buildGraph(many, []));
	expect(performance.now() - started).toBeLessThan(1500);
});
