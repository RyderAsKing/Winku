import { expect, test } from "bun:test";
import { placeVisual, type ReplyVisual } from "../src/main/visuals.ts";

const v = (id: string, at: number): ReplyVisual => ({ requestId: `r-${id}`, id, title: id, at });

test("a new visual is added after the others", () => {
	expect(placeVisual([v("a", 3)], v("b", 9)).map((x) => x.id)).toEqual(["a", "b"]);
});

test("a replacement takes the old visual's place and position in the text", () => {
	const out = placeVisual([v("a", 3), v("b", 5)], v("c", 20), "a");
	expect(out.map((x) => [x.id, x.at])).toEqual([["c", 3], ["b", 5]]);
});

test("a replacement for a visual not in this reply is added where the text has got to", () => {
	expect(placeVisual([v("a", 3)], v("c", 20), "zzz").map((x) => [x.id, x.at])).toEqual([["a", 3], ["c", 20]]);
});
