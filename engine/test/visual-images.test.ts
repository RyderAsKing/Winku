import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_IMAGE_BYTES, MAX_INLINE_IMAGE_BYTES, inlineLocalImages } from "../src/tools/visual-images.ts";

const dir = mkdtempSync(join(tmpdir(), "winku-images-"));
// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const file = (name: string, bytes: Buffer | string) => {
	const path = join(dir, name);
	writeFileSync(path, bytes);
	return path;
};

test("a local image named by absolute path is written into the page as data", () => {
	const path = file("dot.png", PNG);
	const out = inlineLocalImages(`<img alt="dot" src="${path}"><img src='file://${path}'>`);
	const data = `data:image/png;base64,${PNG.toString("base64")}`;
	expect(out).toBe(`<img alt="dot" src="${data}"><img src='${data}'>`);
});

test("the type comes from the bytes, not the file name", () => {
	const path = file("really-a-png.jpg", PNG);
	expect(inlineLocalImages(`<img src="${path}">`)).toContain("data:image/png;base64,");
});

test("a text file renamed to .png is refused", () => {
	const path = file("notes.png", "these are my notes, not a picture");
	expect(() => inlineLocalImages(`<img src="${path}">`)).toThrow(/not an image/);
});

test("a missing file is refused, naming the path", () => {
	expect(() => inlineLocalImages(`<img src="${join(dir, "nope.png")}">`)).toThrow(/nope\.png/);
});

test("an image over the per-image limit is refused with advice to use smaller images", () => {
	const path = file("huge.png", Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
	expect(() => inlineLocalImages(`<img src="${path}">`)).toThrow(/smaller images/);
});

test("images that together push the page over its limit are refused with advice to use smaller images", () => {
	const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES - PNG.length - 1)]);
	const count = Math.ceil(MAX_INLINE_IMAGE_BYTES / MAX_IMAGE_BYTES) + 1;
	const html = Array.from({ length: count }, (_, i) => `<img src="${file(`part${i}.png`, big)}">`).join("");
	expect(() => inlineLocalImages(html)).toThrow(/smaller images/);
});

test("remote and data images, scripts and relative paths are left as written", () => {
	const html = `<img src="https://example.com/a.png"><script src="https://cdn.example.com/chart.js"></script><img src="//cdn.example.com/b.png"><img src="data:image/png;base64,AAAA"><a href="/docs">x</a>`;
	expect(inlineLocalImages(html)).toBe(html);
});
