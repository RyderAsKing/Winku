// Screenshots of the UI running on the browser mock shell (ui/src/lib/mock.ts): no Tauri,
// no engine, no keys. Start the UI first:  bun run ui:dev   (serves http://127.0.0.1:5173)
//
//   bun run screenshots [before|after] [case …]
//   BASE_URL=http://127.0.0.1:5173 bun run screenshots after bar reply
//
// Output: app/.screenshots/<label>/<case>-<viewport>.png
// Winku is a desktop app, so the two sizes are a normal and a high-DPI display, not mobile.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseURL = process.env.BASE_URL || "http://127.0.0.1:5173";
const label = process.argv[2] || "after";
const selected = process.argv.slice(3);

const summon = async (page) => {
	await page.getByRole("button", { name: "Open Winku" }).click();
	await page.getByRole("textbox", { name: "Message" }).waitFor();
};
const ui = (page, event) => page.evaluate((e) => window.__winkuMock.ui(e), event);
const action = (page, slot, selection) => page.evaluate(([s, t]) => window.__winkuMock.action(s, t), [slot, selection]);
const engine = (page, event) => page.evaluate((e) => window.__winkuMock.engine(e), event);
const talk = (page, text, ms) => page.evaluate(([t, m]) => window.__winkuMock.talk(t, m), [text, ms]);

const cases = [
	{ name: "pill", path: "/", ready: "role=button[name='Open Winku']" },
	{ name: "pill-full-context", path: "/?ctx=0.95&thinking=high", ready: "role=button[name='Open Winku']" },
	{ name: "bar", path: "/", ready: "text=23% ctx", prepare: summon },
	{
		name: "reply",
		path: "/",
		ready: "text=Paste it into Paint",
		prepare: async (page) => {
			await summon(page);
			await page.getByRole("textbox", { name: "Message" }).fill("How do I take a screenshot of part of the screen?");
			await page.keyboard.press("Enter");
			await page.getByText("Paste it into Paint").waitFor();
			await page.waitForTimeout(400); // let reply_end land
		},
	},
	{
		name: "pill-update",
		path: "/?update=1",
		ready: ".head .dot",
	},
	{
		name: "bar-update",
		path: "/?update=1",
		ready: "text=Restart to update",
		prepare: summon,
	},
	{
		name: "listening",
		path: "/?voice=1",
		ready: ".eyes[aria-label='Winku is listening']",
		prepare: (page) => talk(page, "", -1),
	},
	{
		name: "downloading",
		path: "/?download=1",
		ready: ".eyes[aria-label^='Downloading a voice model']",
		prepare: (page) => talk(page, "", -1),
	},
	{
		name: "spoken-reply",
		path: "/?voice=1",
		ready: ".eyes[aria-label='Winku is speaking']",
		prepare: async (page) => {
			await page.getByRole("button", { name: "Open Winku" }).waitFor();
			await talk(page, "How do I take a screenshot of part of the screen?", 600);
			await page.getByText("to save or share it.").waitFor();
			// After reply_end the happy look plays, then text-to-speech takes over.
			await page.locator(".eyes[aria-label='Winku is speaking']").waitFor();
		},
	},
	{
		name: "error",
		path: "/",
		ready: "role=alert",
		prepare: async (page) => {
			await summon(page);
			await engine(page, { type: "error", errorKind: "auth", message: "Anthropic rejected the API key (401)." });
		},
	},
	{
		name: "cleared",
		path: "/",
		ready: "text=Context cleared",
		prepare: async (page) => {
			await summon(page);
			await ui(page, { kind: "clear" });
		},
	},
	{
		name: "chips",
		path: "/",
		ready: "text=Selection, 9 words",
		prepare: async (page) => {
			await ui(page, { kind: "ask_selection", text: "Thanks for the quick turnaround, I'll loop in Sam." });
		},
	},
	{
		name: "transcript",
		path: "/",
		ready: "text=Earlier conversation summarized",
		prepare: async (page) => {
			await summon(page);
			await page.keyboard.press("Control+j");
		},
	},
	{
		name: "connect",
		path: "/?connect=1",
		ready: "text=Connect a model",
		prepare: async (page) => {
			await summon(page);
			await page.waitForFunction(() => document.querySelector("select")?.value);
		},
	},
	{
		name: "action-show",
		path: "/",
		ready: "text=the second flip undoes the first",
		prepare: async (page) => {
			await action(page, 4);
			await page.getByText("the second flip undoes the first").waitFor();
			await page.waitForTimeout(300); // let action_end land
		},
	},
	{
		name: "action-no-selection",
		path: "/",
		ready: "text=Select some text first",
		prepare: (page) => action(page, 2, ""),
	},
	{
		name: "memory-saved",
		path: "/",
		ready: "text=Show the new profile",
		prepare: async (page) => {
			await summon(page);
			await page.getByRole("textbox", { name: "Message" }).fill("Remember that I sign off work emails with “Cheers, Sam”");
			await page.keyboard.press("Enter");
			await page.getByText("Show the new profile").waitFor();
			await page.waitForTimeout(300);
		},
	},
	{
		name: "permission",
		path: "/?ask=1",
		ready: "text=Always allow this command",
		prepare: async (page) => {
			await summon(page);
			await page.getByRole("textbox", { name: "Message" }).fill("Clean up the temp files in my Downloads folder");
			await page.keyboard.press("Enter");
			await page.getByText("Always allow this command").waitFor();
		},
	},
	{
		name: "settings-tools",
		path: "/settings.html?ask=1",
		size: { width: 680, height: 1040 },
		ready: '[placeholder="Brave Search API key"]',
		prepare: async (page) => {
			await page.getByRole("heading", { name: "Tools" }).waitFor();
			await page.getByRole("heading", { name: "Tools" }).evaluate((el) => el.scrollIntoView());
		},
	},
	{
		name: "settings-speech",
		path: "/settings.html",
		size: { width: 680, height: 1040 },
		ready: "role=heading[name='Speech']",
		prepare: async (page) => {
			await page.getByRole("heading", { name: "Speech" }).evaluate((el) => el.scrollIntoView());
			await page.getByRole("option", { name: "Microsoft Zira (en-US)" }).waitFor({ state: "attached" });
		},
	},
	{
		name: "settings-app",
		path: "/settings.html?update=1",
		size: { width: 680, height: 1040 },
		ready: "role=heading[name='App']",
		prepare: async (page) => {
			await page.getByRole("heading", { name: "App" }).evaluate((el) => el.closest("section").scrollIntoView({ block: "end" }));
			await page.getByText("installs when you quit or restart").waitFor();
		},
	},
	{
		name: "settings-memory",
		path: "/settings.html",
		size: { width: 680, height: 1040 },
		ready: "text=Use a voice for this app",
		prepare: async (page) => {
			await page.getByRole("heading", { name: "Memory and voice" }).waitFor();
			await page.getByRole("button", { name: "Forget everything" }).click();
			await page.getByRole("heading", { name: "Memory and voice" }).evaluate((el) => el.scrollIntoView());
		},
	},
	{
		name: "settings-actions",
		path: "/settings.html",
		size: { width: 680, height: 1040 },
		ready: "text=Use the conversation as context",
		prepare: async (page) => {
			await page.getByRole("heading", { name: "Actions" }).waitFor();
			await page.getByRole("textbox", { name: "Action 2 prompt" }).fill("Fix spelling and grammar. Keep British spelling.");
			await page.getByRole("heading", { name: "Actions" }).evaluate((el) => el.scrollIntoView());
		},
	},
	{ name: "eyes", path: "/eyes.html", size: { width: 900, height: 760 }, fullPage: true, ready: "text=Lids by context fullness" },
	{ name: "settings", path: "/settings.html", size: { width: 680, height: 1040 }, ready: "text=Leader key" },
	{
		name: "settings-keys-warnings",
		path: "/settings.html?altgr=1&taken=action2",
		size: { width: 680, height: 1040 },
		ready: "text=Use Ctrl+Shift instead",
	},
	{
		name: "history",
		path: "/history.html",
		size: { width: 760, height: 560 },
		ready: "role=button[name='Restore as current']",
		prepare: async (page) => {
			await page.getByText("Draft a polite reply").click();
			await page.getByText("Quality 82 keeps text sharp", { exact: false }).waitFor();
		},
	},
];

// Stress fixtures use the public mock hooks and URL options, just like the original cases.
for (const heading of ["Model", "Conversation", "Tools", "Speech", "Memory and voice", "Actions", "Keys", "Eyes", "App"]) {
	cases.push({
		name: `settings-real-${heading.toLowerCase().replaceAll(" ", "-")}`,
		path: "/settings.html?ask=1&altgr=1&taken=action2",
		size: { width: 680, height: 520 },
		ready: `role=heading[name='${heading}']`,
		prepare: async (page) => {
			await page.getByRole("heading", { name: heading, exact: true }).evaluate((el) => el.scrollIntoView({ block: "start" }));
		},
	});
}
cases.push(
	{ name: "history-empty", path: "/history.html?empty=1", size: { width: 760, height: 560 }, ready: "text=No history yet." },
	{ name: "history-many", path: "/history.html?many=1&long=1", size: { width: 760, height: 560 }, ready: "text=Archive 1:" },
	{
		name: "history-no-results",
		path: "/history.html",
		size: { width: 760, height: 560 },
		ready: "text=No matches.",
		prepare: async (page) => {
			await page.getByRole("searchbox").fill("no-such-conversation");
		},
	},
	{
		name: "transcript-long",
		path: "/?long=1",
		ready: "text=Files ready for review",
		prepare: async (page) => {
			await summon(page);
			await page.keyboard.press("Control+j");
		},
	},
	{
		name: "reply-long-tools",
		path: "/",
		ready: "text=Review complete",
		prepare: async (page) => {
			await summon(page);
			await page.getByRole("textbox", { name: "Message" }).fill("Review these files");
			await page.keyboard.press("Enter");
			await page.waitForTimeout(3500);
			await ui(page, { kind: "action_started", id: "stress", slot: 4, name: "Review files", output: "show" });
			for (let i = 0; i < 12; i++) {
				await engine(page, {
					type: "tool_start",
					id: "stress",
					toolCallId: `stress-${i}`,
					name: "read",
					summary: `C:\\Projects\\${"LongDirectory".repeat(12)}\\file-${i}.md`,
				});
				await engine(page, {
					type: "tool_end",
					id: "stress",
					toolCallId: `stress-${i}`,
					ok: i !== 5,
					summary: `C:\\Projects\\${"LongDirectory".repeat(12)}\\file-${i}.md`,
				});
			}
			await engine(page, { type: "action_delta", id: "stress", delta: "Review complete. " + "Unbroken".repeat(45) });
		},
	},
	{
		name: "error-long",
		path: "/",
		ready: "role=alert",
		prepare: async (page) => {
			await summon(page);
			await engine(page, {
				type: "error",
				errorKind: "auth",
				message: "Connection failed for https://example.com/" + "endpoint".repeat(35),
			});
		},
	},
	{
		name: "connect-custom",
		path: "/?connect=1",
		ready: "text=Base URL",
		prepare: async (page) => {
			await summon(page);
			await page.getByRole("combobox").first().selectOption("__custom__");
		},
	},
	{
		name: "focus-message",
		path: "/",
		ready: "textarea:focus-visible",
		prepare: async (page) => {
			await summon(page);
			await page.keyboard.press("Tab");
			await page.keyboard.press("Shift+Tab");
		},
	},
	{
		name: "focus-settings",
		path: "/settings.html",
		size: { width: 680, height: 520 },
		ready: ":focus-visible",
		prepare: async (page) => {
			await page.getByRole("heading", { name: "Model", exact: true }).waitFor();
			await page.keyboard.press("Tab");
			await page.keyboard.press("Tab");
		},
	},
	{
		name: "focus-pill",
		path: "/",
		ready: ".head .eyes:focus-visible",
		prepare: async (page) => {
			await page.keyboard.press("Tab");
		},
	},
);

cases.push(
	{
		name: "streaming",
		path: "/",
		ready: ".md",
		prepare: async (page) => {
			await summon(page);
			await page.clock.install();
			await page.getByRole("textbox", { name: "Message" }).fill("How do I take a screenshot?");
			await page.keyboard.press("Enter");
			await page.clock.runFor(1300);
		},
	},
	{
		name: "proposal-expanded",
		path: "/",
		ready: ".proposal details[open]",
		prepare: async (page) => {
			await summon(page);
			await page.getByRole("textbox", { name: "Message" }).fill("Remember my work sign-off");
			await page.keyboard.press("Enter");
			await page.getByText("Show the new profile").click();
		},
	},
	{
		name: "settings-custom",
		path: "/settings.html",
		size: { width: 680, height: 520 },
		ready: "text=Context window",
		prepare: async (page) => {
			await page.getByRole("combobox").first().selectOption("__custom__");
		},
	},
	{
		name: "settings-quick-model",
		path: "/settings.html",
		size: { width: 680, height: 520 },
		ready: "[placeholder='Model id']",
		prepare: async (page) => {
			await page.getByLabel("Quick actions model", { exact: true }).selectOption("false");
		},
	},
);

const viewports = [
	{ name: "desktop", width: 1280, height: 800, deviceScaleFactor: 1 },
	{ name: "hidpi", width: 1280, height: 800, deviceScaleFactor: 2 },
];

if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error("Use a simple capture label, e.g. before or after.");
for (const name of selected) {
	if (!cases.some((c) => c.name === name)) throw new Error(`Unknown case: ${name}. Known: ${cases.map((c) => c.name).join(", ")}`);
}
const targets = cases.filter((c) => selected.length === 0 || selected.includes(c.name));
const out = path.resolve(import.meta.dirname, "..", ".screenshots", label);
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
try {
	for (const item of targets) {
		for (const vp of viewports) {
			const context = await browser.newContext({
				viewport: item.size ?? { width: vp.width, height: vp.height },
				deviceScaleFactor: vp.deviceScaleFactor,
				colorScheme: "dark",
				reducedMotion: "reduce",
				locale: "en-US",
				timezoneId: "UTC",
			});
			try {
				context.setDefaultTimeout(15000);
				const page = await context.newPage();
				const response = await page.goto(new URL(item.path, baseURL).href, { waitUntil: "domcontentloaded" });
				if (!response?.ok()) throw new Error(`${item.name}: HTTP ${response?.status() ?? "no response"}`);
				await page.getByRole("button", { name: "Open Winku" }).or(page.locator("main")).first().waitFor();
				if (item.prepare) await item.prepare(page);
				await page.locator(item.ready).first().waitFor({ state: "visible" });
				await page.evaluate(() => document.fonts.ready);
				const file = path.join(out, `${item.name}-${vp.name}.png`);
				// Clip to what the window draws (pill or bar, bubble) plus a margin of stand-in desktop.
				const box = item.size
					? null
					: await page.evaluate(() => {
							const rects = [...document.querySelectorAll(".head, .bubbles")].map((el) => el.getBoundingClientRect());
							if (rects.length === 0) return null;
							const x = Math.min(...rects.map((r) => r.left));
							const y = Math.min(...rects.map((r) => r.top));
							return { x, y, width: Math.max(...rects.map((r) => r.right)) - x, height: Math.max(...rects.map((r) => r.bottom)) - y };
						});
				const m = 40;
				const clip = box && {
					x: Math.max(0, box.x - m),
					y: Math.max(0, box.y - m),
					width: Math.min(vp.width, box.width + 2 * m),
					height: Math.min(vp.height, box.height + 2 * m),
				};
				await page.screenshot({
					path: file,
					animations: "disabled",
					caret: "hide",
					fullPage: Boolean(item.fullPage),
					...(clip ? { clip } : {}),
				});
				console.log(file);
			} finally {
				await context.close();
			}
		}
	}
} finally {
	await browser.close();
}
