// Recall quality on real vectors: notes and messages embedded by the model Winku downloads
// (fixtures/recall-eval.json), with the notes each message should and shouldn't bring along.
// Moving a recall threshold or rule should keep every case here passing.

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory.ts";
import { RecallIndex } from "../src/recall.ts";

interface Case {
	text: string;
	want: string[];
	avoid: string[] | "all";
	vector: string;
	note?: string;
}

const spec = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "recall-eval.json"), "utf8")) as {
	notes: { topic: string; title: string; body: string; important: boolean; vector: string }[];
	queries: Case[];
};

const decode = (b64: string) => {
	const bytes = Buffer.from(b64, "base64");
	return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};

const vectors = new Map<string, Float32Array>();
for (const n of spec.notes) vectors.set(`${n.title}\n${n.body}`, decode(n.vector));
for (const q of spec.queries) vectors.set(q.text, decode(q.vector));

const dir = mkdtempSync(join(tmpdir(), "winku-recall-eval-"));
const store = new MemoryStore(dir);
for (const n of spec.notes) store.save({ title: n.title, topic: n.topic, content: n.body, important: n.important }, "eval");
const index = new RecallIndex(store, RecallIndex.pathFor(dir), async (texts) =>
	texts.map((t) => {
		const v = vectors.get(t);
		if (!v) throw new Error(`no vector for ${JSON.stringify(t)}`);
		return v;
	}),
);
index.warm();
await index.settled();

for (const q of spec.queries) {
	test(`recall for "${q.text}"`, async () => {
		const sent = (await index.explain(q.text)).sent.map((n) => n.title);
		for (const title of q.want) expect(sent).toContain(title);
		if (q.avoid === "all") expect(sent).toEqual([]);
		else for (const title of q.avoid) expect(sent).not.toContain(title);
	});
}

test("cleanup", () => {
	index.close();
	rmSync(dir, { recursive: true, force: true });
});
