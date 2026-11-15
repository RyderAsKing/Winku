import { expect, test } from "bun:test";
import { isBridgeMessage, isWebLink, winkuKey } from "../src/main/visuals.ts";

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
