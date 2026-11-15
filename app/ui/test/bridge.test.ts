// The BRIDGE script every visual runs first (app/src-tauri/src/bridge.js), in headless Chromium:
// a sandboxed frame, as in Visual.svelte, posting to a parent that records what arrives.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type Browser, chromium, type Page } from "playwright";

const BRIDGE = readFileSync(new URL("../../src-tauri/src/bridge.js", import.meta.url), "utf8");

let browser: Browser;
beforeAll(async () => {
	browser = await chromium.launch();
});
afterAll(async () => {
	await browser?.close();
});

type Posted = Record<string, unknown>;

/** A parent page holding `body` in a sandboxed frame, with what the frame posted. */
async function framed(body: string): Promise<{ page: Page; posted: () => Promise<Posted[]> }> {
	const page = await browser.newPage();
	const doc = `<!doctype html><html><head><script>${BRIDGE}</script></head><body>${body}</body></html>`;
	await page.setContent(
		`<script>window.posted=[];addEventListener("message",e=>{if(e.source===document.querySelector("iframe").contentWindow)posted.push(e.data)})</script>
		<iframe sandbox="allow-scripts" style="width:400px;height:300px" srcdoc="${doc.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>`,
	);
	const posted = () => page.evaluate(() => (window as unknown as { posted: Posted[] }).posted);
	for (let i = 0; i < 50 && !(await posted()).some((m) => m.kind === "loaded"); i++) await page.waitForTimeout(20);
	return { page, posted };
}

const frameOf = (page: Page) => page.frames()[1];

test("a link click is reported and not followed", async () => {
	const { page, posted } = await framed(`<a id="l" href="https://example.com/x">x</a>`);
	await frameOf(page).click("#l");
	await page.waitForTimeout(50);
	expect((await posted()).filter((m) => m.kind === "link")).toEqual([{ winku: "visual", kind: "link", href: "https://example.com/x" }]);
	expect(frameOf(page).url()).toBe("about:srcdoc");
	await page.close();
});

test("a click on the visual is reported; a click on a control is the page's", async () => {
	const { page, posted } = await framed(`<img id="i" width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><button id="b">b</button>`);
	await frameOf(page).click("#i");
	await frameOf(page).click("#b");
	await page.waitForTimeout(50);
	expect((await posted()).filter((m) => m.kind === "click")).toEqual([{ winku: "visual", kind: "click" }]);
	await page.close();
});

test("Esc and Ctrl chords reach Winku; plain typing stays in the page", async () => {
	const { page, posted } = await framed(`<input id="t">`);
	await frameOf(page).focus("#t");
	await page.keyboard.type("hi");
	await page.keyboard.press("Escape");
	await page.keyboard.press("Control+j");
	await page.waitForTimeout(50);
	expect((await posted()).filter((m) => m.kind === "key")).toEqual([
		{ winku: "visual", kind: "key", key: "Escape", ctrl: false, alt: false, shift: false, meta: false },
		{ winku: "visual", kind: "key", key: "j", ctrl: true, alt: false, shift: false, meta: false },
	]);
	await page.close();
});

test("Winku's theme sets the page's CSS variables; nothing else from outside does", async () => {
	const { page } = await framed(`<p>x</p>`);
	await page.evaluate(() => {
		const w = document.querySelector("iframe")!.contentWindow!;
		w.postMessage({ winku: "theme", vars: { "--accent": "#5ee", "color": "red", "--x;y": "1", "--long": "x".repeat(500) } }, "*");
	});
	await page.waitForTimeout(50);
	const style = await frameOf(page).evaluate(() => document.documentElement.getAttribute("style") ?? "");
	expect(style).toContain("--accent: #5ee");
	expect(style).not.toContain("red");
	expect(style).not.toContain("--long");
	// A message the page posts to itself is not Winku's.
	await frameOf(page).evaluate(() => window.postMessage({ winku: "theme", vars: { "--accent": "#f00" } }, "*"));
	await page.waitForTimeout(50);
	expect(await frameOf(page).evaluate(() => document.documentElement.style.getPropertyValue("--accent"))).toBe("#5ee");
	await page.close();
});
