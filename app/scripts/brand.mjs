// Renders the brand sources in docs/brand/ to the PNGs that are built from them:
//
//   docs/brand/mark.png          the mark at 1024 px
//   docs/brand/social-card.png   GitHub's social preview, from social-card.html
//   src-tauri/icons/*            the app icons, through `tauri icon`
//
//   bun run brand
//
// The SVGs in docs/brand/ are the sources; edit those, then run this. See docs/brand/BRAND.md.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brand = path.resolve(app, "../docs/brand");
const icons = path.join(app, "src-tauri/icons");

const browser = await chromium.launch();
try {
	const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
	await page.goto(pathToFileURL(path.join(brand, "mark.svg")).href);
	await page.screenshot({ path: path.join(brand, "mark.png"), omitBackground: true });

	await page.setViewportSize({ width: 1280, height: 640 });
	await page.goto(pathToFileURL(path.join(brand, "social-card.html")).href);
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: path.join(brand, "social-card.png") });
} finally {
	await browser.close();
}

// `tauri icon` also writes Android, iOS and macOS icons; keep only the ones the app already ships.
const out = mkdtempSync(path.join(tmpdir(), "winku-icons-"));
try {
	const run = spawnSync("bun", ["x", "tauri", "icon", path.join(brand, "mark.png"), "--output", out], { cwd: app, stdio: "inherit" });
	if (run.status !== 0) throw new Error("tauri icon failed");
	for (const name of readdirSync(icons)) copyFileSync(path.join(out, name), path.join(icons, name));
} finally {
	rmSync(out, { recursive: true, force: true });
}
console.log("Wrote docs/brand/mark.png, docs/brand/social-card.png and src-tauri/icons/.");
