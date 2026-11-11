// Interaction and containment checks against the browser mock. Run with Vite on BASE_URL.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const base = process.env.BASE_URL || "http://127.0.0.1:5180";
const page = await browser.newPage({ viewport: { width: 680, height: 520 }, reducedMotion: "reduce" });
try {
	await page.goto(base);
	await page.getByRole("button", { name: "Open Winku" }).waitFor();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Enter");
	await page.getByRole("textbox", { name: "Message" }).waitFor();
	await page.evaluate(() =>
		window.__winkuMock.engine({ type: "error", errorKind: "auth", message: "https://example.com/" + "long-path".repeat(90) }),
	);
	const reply = page.locator(".reply");
	assert(await reply.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "Long errors must stay inside the reply");
	await page.goto(base + "/?long=1");
	await page.getByRole("button", { name: "Open Winku" }).click();
	await page.keyboard.press("Control+j");
	await page.getByText("Files ready for review", { exact: true }).waitFor();
	assert(await page.locator(".list").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "Transcript must not scroll sideways");
	assert(
		await page
			.locator(".md pre")
			.last()
			.evaluate((el) => el.scrollWidth > el.clientWidth),
		"Long code should scroll within its block",
	);
	await page.goto(base + "/settings.html");
	const hotkey = page.getByRole("button", { name: /Open the bar.*Click to change/ });
	await hotkey.click();
	await page.keyboard.press("Tab");
	assert((await hotkey.getAttribute("aria-pressed")) === "false", "Tab must leave hotkey capture");
	assert(await hotkey.evaluate((el) => el !== document.activeElement), "Hotkey capture must not trap focus");
	for (const name of ["Provider", "Main model", "Main thinking level"]) {
		assert((await page.getByLabel(name, { exact: true }).count()) === 1, `${name} must be named`);
	}
	const contrast = await page.evaluate(() => {
		const css = getComputedStyle(document.documentElement);
		const lum = (value) => {
			const rgb = value
				.trim()
				.replace("#", "")
				.match(/../g)
				.map((v) => parseInt(v, 16) / 255)
				.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
			return rgb.reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
		};
		const bg = lum(css.getPropertyValue("--panel-raised"));
		return ["--text", "--muted", "--faint"].map((key) => (lum(css.getPropertyValue(key)) + 0.05) / (bg + 0.05));
	});
	assert(
		contrast.every((ratio) => ratio >= 4.5),
		`Body and hint contrast: ${contrast}`,
	);
	await page.goto(base + "/history.html?many=1&long=1");
	await page.getByText("Files ready for review", { exact: true }).waitFor();
	assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "History must fit its window");
	console.log(
		"UI audit passed: keyboard activation, Tab escape, accessible field names, long content containment, local code scrolling, and AA text contrast.",
	);
	console.log("Text contrast against raised controls:", contrast.map((n) => n.toFixed(2)).join(", "));
} finally {
	await browser.close();
}
