// The pictures in the README and the user docs, captured from the UI on the browser mock shell
// (no Tauri, no engine, no keys). Start the UI first:  bun run ui:dev   (serves http://127.0.0.1:5173)
//
//   bun run readme-media
//
// Writes docs/media/eyes.png and transcript.png. Set BASE_URL if the UI runs elsewhere.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const baseURL = process.env.BASE_URL || "http://127.0.0.1:5173";
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const media = path.resolve(app, "../docs/media");
mkdirSync(media, { recursive: true });

/** Puts a plain wallpaper behind the browser preview, with the eyes near the top-right corner. */
async function dress(page) {
	await page.getByRole("button", { name: "Open Winku" }).waitFor();
	await page.addStyleTag({
		content: `
			body { background: linear-gradient(160deg, #2b3a55 0%, #1d2536 55%, #151a26 100%) !important; }
			.framed { background: none !important; z-index: 1; }
			.framed .stage { top: 20px !important; }
			.framed .stage.right { right: 20px !important; }`,
	});
}

/** Clicks the eyes until the bar is open; an idle glance can move them under the pointer. */
async function summon(page) {
	for (let tries = 0; tries < 5; tries++) {
		await page.getByRole("button", { name: "Open Winku" }).click();
		try {
			await page.getByRole("textbox", { name: "Message" }).waitFor({ timeout: 1500 });
			return;
		} catch {}
	}
	throw new Error("the bar didn't open");
}

const browser = await chromium.launch();
try {
	const page = await browser.newPage({ viewport: { width: 900, height: 760 }, deviceScaleFactor: 2 });

	// Every eye state, from the gallery's first section.
	await page.goto(`${baseURL}/eyes.html`);
	await page.getByText("Lids by context fullness").waitFor();
	await page.waitForTimeout(500);
	await page.locator(".grid").first().screenshot({ path: path.join(media, "eyes.png") });

	// The whole conversation (Ctrl+J). The stage is wider than the bar (it widens when scrolled
	// back) and keeps a strip above the pill, so crop to the bar and the bubble.
	await page.setViewportSize({ width: 640, height: 520 });
	await page.goto(`${baseURL}/`);
	await dress(page);
	await summon(page);
	await page.keyboard.press("Control+j");
	await page.getByText("Earlier conversation summarized").waitFor();
	await page.mouse.move(0, 0);
	await page.waitForTimeout(1200);
	await page.screenshot({ path: path.join(media, "transcript.png"), clip: { x: 200, y: 28, width: 440, height: 492 } });
	await page.close();
} finally {
	await browser.close();
}
