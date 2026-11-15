// The README's demo GIF and pictures, captured from the UI on the browser mock shell (no Tauri,
// no engine, no keys). Start the UI first:  bun run ui:dev   (serves http://127.0.0.1:5173)
//
//   bun run readme-media
//
// Writes docs/media/demo.gif, eyes.png and transcript.png. Needs ffmpeg on PATH.
// The demo puts Winku on a plain stand-in desktop: a real Windows recording can replace
// demo.gif later without changing the README.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const baseURL = process.env.BASE_URL || "http://127.0.0.1:5173";
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const media = path.resolve(app, "../docs/media");
mkdirSync(media, { recursive: true });

/**
 * Turns the browser preview's backdrop into a stand-in desktop: a wallpaper and a document
 * window, with the eyes near the top-right corner of the screen.
 */
async function dress(page, { withDoc = true } = {}) {
	await page.getByRole("button", { name: "Open Winku" }).waitFor();
	await page.addStyleTag({
		content: `
			body { background: linear-gradient(160deg, #2b3a55 0%, #1d2536 55%, #151a26 100%) !important; }
			.framed { background: none !important; z-index: 1; }
			.framed .stage { top: 20px !important; }
			.framed .stage.right { right: 20px !important; }
			.doc { position: absolute; left: 36px; top: 52px; width: 400px; height: 330px; border-radius: 10px; background: #f3f4f7; box-shadow: 0 16px 40px rgb(0 0 0 / 0.35); overflow: hidden; }
			.doc header { height: 30px; background: #e4e7ee; display: flex; align-items: center; padding: 0 14px; font: 12px "Segoe UI", system-ui, sans-serif; color: #4a5160; }
			.doc .line { height: 9px; margin: 16px 22px 0; border-radius: 4px; background: #cfd5df; }
			.doc .gap { height: 12px; }`,
	});
	if (!withDoc) return;
	await page.evaluate(() => {
		const doc = document.createElement("div");
		doc.className = "doc";
		doc.innerHTML =
			"<header>Quarterly notes.docx</header>" +
			[92, 80, 86, 60, 0, 88, 74, 90, 52].map((w) => (w ? `<div class="line" style="width:${w}%"></div>` : `<div class="gap"></div>`)).join("");
		// Outside the app's root, which re-renders.
		document.body.prepend(doc);
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

async function demo(browser) {
	const size = { width: 880, height: 420 };
	const dir = mkdtempSync(path.join(tmpdir(), "winku-demo-"));
	try {
		const context = await browser.newContext({ viewport: size, recordVideo: { dir, size } });
		const page = await context.newPage();
		await page.goto(`${baseURL}/?voice=1`);
		await dress(page);
		await page.waitForTimeout(1500);

		// Tap the key: the eyes open into the bar. Type, send, and the reply streams in.
		await summon(page);
		const box = page.getByRole("textbox", { name: "Message" });
		await page.waitForTimeout(400);
		await box.pressSequentially("How do I take a screenshot of part of the screen?", { delay: 34 });
		await page.waitForTimeout(300);
		await box.press("Enter");
		await page.getByText("Paste it into Paint").waitFor();
		await page.waitForTimeout(2800);

		// Esc twice: stop, then hide the bar, back to the resting eyes.
		await page.keyboard.press("Escape");
		await page.waitForTimeout(200);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(1000);

		// Hold to talk: the eyes listen, the words appear, and the reply is read out.
		await page.evaluate(() => window.__winkuMock.talk("Can you say that again, out loud?", 1600));
		await page.locator(".eyes[aria-label='Winku is speaking']").waitFor();
		await page.waitForTimeout(2600);

		await context.close();
		const [video] = readdirSync(dir).filter((f) => f.endsWith(".webm"));
		const out = path.join(media, "demo.gif");
		// Trim the blank first frames while the page loads.
		const ff = spawnSync(
			"ffmpeg",
			[
				"-y", "-loglevel", "error", "-ss", "0.6", "-i", path.join(dir, video), "-vf",
				"fps=15,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
				out,
			],
			{ stdio: "inherit" },
		);
		if (ff.status !== 0) throw new Error("ffmpeg failed");
		console.log(out);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function stills(browser) {
	const page = await browser.newPage({ viewport: { width: 900, height: 760 }, deviceScaleFactor: 2 });

	// Every eye state, from the gallery's first section.
	await page.goto(`${baseURL}/eyes.html`);
	await page.getByText("Lids by context fullness").waitFor();
	await page.waitForTimeout(500);
	await page.locator(".grid").first().screenshot({ path: path.join(media, "eyes.png") });

	// The whole conversation (Ctrl+J).
	// The stage is wider than the bar (it widens when scrolled back) and keeps a strip above the
	// pill, so crop to the bar and the bubble.
	await page.setViewportSize({ width: 640, height: 520 });
	await page.goto(`${baseURL}/`);
	await dress(page, { withDoc: false });
	await summon(page);
	await page.keyboard.press("Control+j");
	await page.getByText("Earlier conversation summarized").waitFor();
	await page.mouse.move(0, 0);
	await page.waitForTimeout(1200);
	await page.screenshot({ path: path.join(media, "transcript.png"), clip: { x: 200, y: 28, width: 440, height: 492 } });

	await page.close();
}

const browser = await chromium.launch();
try {
	await stills(browser);
	await demo(browser);
} finally {
	await browser.close();
}
