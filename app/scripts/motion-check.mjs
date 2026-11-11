// Checks the eyes' motion budget (SPEC §4) in a real browser against the mock shell:
//   - the resting pill runs no animations at all, so it costs nothing at idle;
//   - the open bar runs no endless loop while idle (blinks are one-off timers);
//   - while a reply streams the speaking bounce runs, and it stops once the bar is hidden;
//   - with "reduce motion" nothing loops, even while speaking.
// Starts its own Vite server unless BASE_URL is set.
//
//   bun run motion-check
import path from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

let server;
let baseURL = process.env.BASE_URL;
if (!baseURL) {
	server = await createServer({
		configFile: path.resolve(import.meta.dirname, "..", "vite.config.ts"),
		server: { port: 5174, strictPort: false, host: "127.0.0.1" },
		logLevel: "error",
	});
	await server.listen();
	baseURL = server.resolvedUrls.local[0];
}

/** Animations currently running on the page, endless ones flagged. */
const running = (page) =>
	page.evaluate(() =>
		document
			.getAnimations()
			.filter((a) => a.playState === "running")
			.map((a) => ({
				name: a.animationName ?? (a.id || a.constructor.name),
				endless: a.effect?.getComputedTiming().iterations === Infinity,
			})),
	);

const failures = [];
function expect(name, ok, detail) {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: ${JSON.stringify(detail)}`}`);
	if (!ok) failures.push(name);
}

async function streamReply(page) {
	await page.getByRole("textbox", { name: "Message" }).fill("hello");
	await page.keyboard.press("Enter");
	await page.waitForFunction(() => document.querySelector(".eyes[role=img]")?.getAttribute("aria-label") === "Winku is speaking");
}

const browser = await chromium.launch({ headless: true, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
try {
	for (const reducedMotion of ["no-preference", "reduce"]) {
		const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion });
		context.setDefaultTimeout(15000);
		const page = await context.newPage();
		page.on("pageerror", (e) => console.error("page error:", e.message));
		await page.goto(baseURL);
		const pill = page.getByRole("button", { name: "Open Winku" });
		await pill.waitFor({ timeout: 60000 }); // the first load compiles the UI
		const tag = reducedMotion === "reduce" ? " (reduce motion)" : "";

		await page.waitForTimeout(1200); // let mount transitions finish
		let anims = await running(page);
		expect(`resting pill runs no animations${tag}`, anims.length === 0, anims);

		await pill.click();
		await page.getByRole("textbox", { name: "Message" }).waitFor();
		await page.waitForTimeout(800);
		anims = await running(page);
		expect(`idle bar runs no endless loop${tag}`, !anims.some((a) => a.endless), anims);

		await streamReply(page);
		anims = await running(page);
		if (reducedMotion === "reduce") expect(`speaking runs no loop${tag}`, !anims.some((a) => a.endless), anims);
		else expect("speaking runs the bounce while the bar shows", anims.some((a) => a.endless && a.name.endsWith("bounce")), anims);

		// Wait for reply_end: the eyes leave speaking for the after-reply look.
		await page.waitForFunction(() => !/thinking|speaking/.test(document.querySelector(".eyes[role=img]")?.getAttribute("aria-label") ?? ""));
		await page.keyboard.press("Escape");
		await pill.waitFor();
		await page.waitForTimeout(3000); // the happy look after a reply, then back to rest
		anims = await running(page);
		expect(`pill is still again after a reply${tag}`, anims.length === 0, anims);
		await context.close();
	}
} finally {
	await browser.close();
	await server?.close();
}

if (failures.length) {
	console.error(`${failures.length} motion check(s) failed`);
	process.exit(1);
}
