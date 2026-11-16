<script lang="ts" module>
	import type { MapNote } from "../lib/memorymap.ts";

	/** What's selected on the map, for the rows App draws under it. */
	export interface Picked {
		key: string;
		label: string;
		/** Hubs: how many notes. */
		size: number;
		note?: MapNote;
		/** Notes in other topics joined to this one by meaning. */
		related: { key: string; label: string }[];
	}

	// Where each node was last placed, kept for the life of the window so a reload after one
	// change doesn't rearrange the whole map.
	const placed = new Map<string, { x: number; y: number }>();
</script>

<script lang="ts">
	// The memory map: topics as hubs, notes around them, dotted lines between notes in different
	// topics that mean similar things. Drag to pan, scroll to zoom, drag a dot to move it, click one
	// to pick it (App shows it below). The list view stays the accessible way through the same notes.
	import type { MemoryLink } from "../../../../engine/src/protocol.ts";
	import { buildGraph, fitView, hit, layout, type MapNode, neighbours, radius, type View } from "../lib/memorymap.ts";

	let { notes, links, picked = $bindable(null) }: { notes: MapNote[]; links: MemoryLink[]; picked?: Picked | null } = $props();

	const HEIGHT = 380;

	let canvas = $state<HTMLCanvasElement>();
	let width = $state(0);
	let view = $state<View>({ x: 0, y: 0, scale: 1 });
	let hovered = $state<string | null>(null);
	let selected = $state<string | null>(null);
	/** Bumped when a dragged node moves, so the map redraws. */
	let moved = $state(0);

	const graph = $derived.by(() => {
		const laid = layout(buildGraph(notes, links), placed);
		for (const n of laid.nodes) placed.set(n.key, { x: n.x, y: n.y });
		return laid;
	});
	const byKey = $derived(new Map(graph.nodes.map((n) => [n.key, n])));
	const near = $derived(neighbours(graph.edges));
	const linkCount = $derived(graph.edges.filter((e) => e.kind === "meaning").length);
	$effect(() => {
		const node = selected ? byKey.get(selected) : undefined;
		if (!node) {
			picked = null;
			return;
		}
		const related = graph.edges
			.filter((e) => e.kind === "meaning" && (e.a === node.key || e.b === node.key))
			.map((e) => byKey.get(e.a === node.key ? e.b : e.a))
			.filter((n): n is MapNode => !!n)
			.map((n) => ({ key: n.key, label: n.label }));
		picked = { key: node.key, label: node.label, size: node.size, note: node.note, related };
	});

	/** Select a node by key (the Related links under the map). */
	export function select(key: string | null) {
		selected = key;
	}

	export function fit() {
		view = fitView(graph.nodes, width, HEIGHT);
	}

	$effect(() => {
		if (!canvas) return;
		const observer = new ResizeObserver(([entry]) => {
			width = Math.round(entry?.contentRect.width ?? 0);
		});
		observer.observe(canvas);
		return () => observer.disconnect();
	});

	// Fit once there's room, and again when a note or topic appears (not on every reload).
	let fittedKeys = new Set<string>();
	$effect(() => {
		if (!width) return;
		const keys = graph.nodes.map((n) => n.key);
		if (fittedKeys.size && keys.every((k) => fittedKeys.has(k))) return;
		view = fitView(graph.nodes, width, HEIGHT);
		fittedKeys = new Set(keys);
	});

	// A note that was deleted can't stay selected.
	$effect(() => {
		if (selected && !byKey.has(selected)) selected = null;
	});

	const css = (name: string) => (canvas ? getComputedStyle(canvas).getPropertyValue(name).trim() : "");

	$effect(() => {
		void moved;
		draw(view, hovered, selected);
	});

	function draw(v: View, hover: string | null, pick: string | null) {
		if (!canvas || !width) return;
		const dpr = window.devicePixelRatio || 1;
		if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
		if (canvas.height !== Math.round(HEIGHT * dpr)) canvas.height = Math.round(HEIGHT * dpr);
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		const text = css("--text") || "#f4f1ea";
		const muted = css("--muted") || "#aaaeb9";
		const accent = css("--accent") || "#5ef6f0";
		const font = css("--font") || "system-ui";
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, HEIGHT);

		const focus = hover ?? pick;
		const lit = focus ? new Set([focus, ...(near.get(focus) ?? [])]) : null;
		const at = (n: MapNode) => [v.x + n.x * v.scale, v.y + n.y * v.scale] as const;

		for (const e of graph.edges) {
			const a = byKey.get(e.a);
			const b = byKey.get(e.b);
			if (!a || !b) continue;
			const touches = focus !== null && (e.a === focus || e.b === focus);
			const [ax, ay] = at(a);
			const [bx, by] = at(b);
			ctx.beginPath();
			ctx.moveTo(ax, ay);
			ctx.lineTo(bx, by);
			ctx.lineWidth = 1;
			if (e.kind === "meaning") {
				ctx.setLineDash([3, 4]);
				ctx.strokeStyle = accent;
				ctx.globalAlpha = touches ? 0.9 : lit ? 0.08 : 0.4;
			} else {
				ctx.setLineDash([]);
				ctx.strokeStyle = touches ? text : muted;
				ctx.globalAlpha = touches ? 0.6 : lit ? 0.06 : 0.22;
			}
			ctx.stroke();
		}
		ctx.setLineDash([]);

		const showNoteLabels = v.scale >= 1.15;
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		for (const n of graph.nodes) {
			const [x, y] = at(n);
			const r = radius(n) * Math.max(0.7, Math.min(1.4, v.scale));
			const isLit = !lit || lit.has(n.key);
			ctx.globalAlpha = isLit ? 1 : 0.2;
			ctx.beginPath();
			ctx.arc(x, y, r, 0, Math.PI * 2);
			ctx.fillStyle = n.key === focus || n.key === pick ? accent : n.kind === "topic" ? text : muted;
			ctx.fill();
			const labelled = n.kind === "topic" || showNoteLabels || (lit !== null && lit.has(n.key));
			if (!labelled) continue;
			ctx.font = `${n.kind === "topic" ? 600 : 400} ${n.kind === "topic" ? 12 : 11}px ${font}`;
			ctx.fillStyle = n.kind === "topic" ? text : muted;
			ctx.globalAlpha = isLit ? (n.kind === "topic" ? 0.95 : 0.85) : 0.15;
			ctx.fillText(clip(ctx, n.label, 160), x, y + r + 4);
		}
		ctx.globalAlpha = 1;
	}

	function clip(ctx: CanvasRenderingContext2D, label: string, max: number): string {
		if (ctx.measureText(label).width <= max) return label;
		let cut = label;
		while (cut.length > 1 && ctx.measureText(`${cut}…`).width > max) cut = cut.slice(0, -1);
		return `${cut.trimEnd()}…`;
	}

	// ── pointer: pan, drag a node, click to select, scroll to zoom ──

	let press: { id: number; x: number; y: number; node: MapNode | null; startX: number; startY: number; moved: boolean } | null = null;

	function local(e: PointerEvent | WheelEvent | MouseEvent) {
		const rect = (canvas as HTMLCanvasElement).getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}
	const toMap = (p: { x: number; y: number }) => ({ x: (p.x - view.x) / view.scale, y: (p.y - view.y) / view.scale });
	const nodeAt = (p: { x: number; y: number }) => {
		const m = toMap(p);
		return hit(graph.nodes, m.x, m.y, 6 / view.scale) ?? null;
	};

	function onpointerdown(e: PointerEvent) {
		if (e.button !== 0 || !canvas) return;
		const p = local(e);
		const node = nodeAt(p);
		press = { id: e.pointerId, x: p.x, y: p.y, node, startX: node ? node.x : view.x, startY: node ? node.y : view.y, moved: false };
		canvas.setPointerCapture(e.pointerId);
	}

	function onpointermove(e: PointerEvent) {
		const p = local(e);
		if (!press || press.id !== e.pointerId) {
			hovered = nodeAt(p)?.key ?? null;
			return;
		}
		const dx = p.x - press.x;
		const dy = p.y - press.y;
		if (!press.moved && Math.hypot(dx, dy) < 4) return;
		press.moved = true;
		if (press.node) {
			press.node.x = press.startX + dx / view.scale;
			press.node.y = press.startY + dy / view.scale;
			placed.set(press.node.key, { x: press.node.x, y: press.node.y });
			moved++;
		} else {
			view = { ...view, x: press.startX + dx, y: press.startY + dy };
		}
	}

	function onpointerup(e: PointerEvent) {
		if (!press || press.id !== e.pointerId) return;
		if (!press.moved) selected = press.node?.key === selected ? null : (press.node?.key ?? null);
		press = null;
	}

	function onwheel(e: WheelEvent) {
		e.preventDefault();
		const p = local(e);
		const scale = Math.min(4, Math.max(0.2, view.scale * Math.exp(-e.deltaY * 0.0015)));
		const m = toMap(p);
		view = { x: p.x - m.x * scale, y: p.y - m.y * scale, scale };
	}
</script>

<div role="img" aria-label="Map of {notes.length} notes in {graph.nodes.length - notes.length} topics, with {linkCount} links between notes that mean similar things. The list view has the same notes.">
<canvas
	bind:this={canvas}
	style:height="{HEIGHT}px"
	class:grab={hovered !== null}
	{onpointerdown}
	{onpointermove}
	{onpointerup}
	onpointercancel={() => (press = null)}
	onpointerleave={() => (hovered = press ? hovered : null)}
	{onwheel}
	ondblclick={(e) => {
		if (!nodeAt(local(e))) fit();
	}}
></canvas>
</div>

<style>
	canvas {
		display: block;
		width: 100%;
		cursor: grab;
		touch-action: none;
	}
	canvas:active {
		cursor: grabbing;
	}
	canvas.grab {
		cursor: pointer;
	}
</style>
