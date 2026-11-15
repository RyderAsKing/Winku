import { expect, test } from "bun:test";
import { isBridgeMessage, isWebLink, placeVisual, replaceInTranscript, type ReplyVisual, winkuKey } from "../src/main/visuals.ts";
import type { TranscriptItem } from "../../../engine/src/protocol.ts";

test("the page may report its height, load, errors, link clicks, clicks and Winku's keys", () => {
	for (const message of [
		{ winku: "visual", kind: "height", height: 120 },
		{ winku: "visual", kind: "loaded", height: 0 },
		{ winku: "visual", kind: "error", message: "boom" },
		{ winku: "visual", kind: "link", href: "https://example.com/a" },
		{ winku: "visual", kind: "click" },
		{ winku: "visual", kind: "key", key: "Escape", ctrl: false, alt: false, shift: false, meta: false },
	]) {
		expect(isBridgeMessage(message)).toBe(true);
	}
});

test("anything else from a page is ignored", () => {
	for (const message of [
		null,
		"height",
		{ kind: "height", height: 1 },
		{ winku: "theme", kind: "height", height: 1 },
		{ winku: "visual", kind: "height", height: Number.NaN },
		{ winku: "visual", kind: "height", height: "1" },
		{ winku: "visual", kind: "send", text: "hi" },
		{ winku: "visual", kind: "prompt", text: "rm -rf" },
		{ winku: "visual", kind: "tool", name: "bash" },
		{ winku: "visual", kind: "link", href: 5 },
		{ winku: "visual", kind: "link", href: "x".repeat(5000) },
		{ winku: "visual", kind: "key", key: "Escape" },
		{ winku: "visual", kind: "key", key: 27, ctrl: false, alt: false, shift: false, meta: false },
		{ winku: "visual", kind: "error", message: 1 },
	]) {
		expect(isBridgeMessage(message)).toBe(false);
	}
});

const key = (key: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) => ({ key, ctrl: false, alt: false, shift: false, meta: false, ...mods });

test("Esc and Ctrl+J are Winku's keys wherever focus is; other keys are the page's", () => {
	expect(winkuKey(key("Escape"))).toBe("escape");
	expect(winkuKey(key("j", { ctrl: true }))).toBe("transcript");
	expect(winkuKey(key("J", { ctrl: true }))).toBe("transcript");
	expect(winkuKey(key("j"))).toBeNull();
	expect(winkuKey(key("j", { ctrl: true, shift: true }))).toBeNull();
	expect(winkuKey(key("j", { ctrl: true, alt: true }))).toBeNull();
	expect(winkuKey(key("Enter"))).toBeNull();
});

test("only http and https links leave a visual", () => {
	expect(isWebLink("https://example.com")).toBe(true);
	expect(isWebLink("HTTP://example.com/x")).toBe(true);
	for (const href of ["file:///C:/Windows", "javascript:alert(1)", "winku-visual://localhost/x.html", "ms-settings:", "data:text/html,x", "https://a\n.com", ""]) {
		expect(isWebLink(href)).toBe(false);
	}
});

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

test("a fix for a visual in an earlier reply takes that visual's place in the loaded transcript", () => {
	const items: TranscriptItem[] = [
		{ kind: "assistant", id: "t1", text: "Here", at: 1 },
		{ kind: "visual", id: "c1:visual", visualId: "a", title: "Pie", at: 2 },
		{ kind: "visual", id: "c2:visual", visualId: "b", title: "Bar", at: 3 },
	];
	const out = replaceInTranscript(items, "a", v("c", 20));
	expect(out?.map((i) => (i.kind === "visual" ? [i.visualId, i.title, i.at] : i.kind))).toEqual([
		"assistant",
		["c", "c", 2],
		["b", "Bar", 3],
	]);
	expect(replaceInTranscript(items, "zzz", v("c", 20))).toBeUndefined();
});
