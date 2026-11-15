// show replacing a broken visual in place (SPEC §7 Showing): the tool, and the thread's transcript.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Request, TranscriptItem } from "../src/protocol.ts";
import { ShellRequests } from "../src/requests.ts";
import { transcriptItems } from "../src/thread.ts";
import { showTool } from "../src/tools/show.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function setup() {
	const dataDir = mkdtempSync(join(tmpdir(), "winku-show-"));
	dirs.push(dataDir);
	const sent: Request[] = [];
	const requests: ShellRequests = new ShellRequests((r) => {
		sent.push(r as Request);
		queueMicrotask(() => requests.handle({ type: "response", id: (r as Request).id, ok: true, data: { height: 80, errors: [] } }));
	});
	const tool = showTool({ requests, dataDir: () => dataDir, replyId: () => "reply-1" });
	const run = (params: { title: string; html: string; replaces?: string }) =>
		// biome-ignore lint/suspicious/noExplicitAny: pi's execute signature
		(tool.execute as any)("call", params, undefined, undefined, undefined);
	return { dataDir, sent, run };
}

test("show tells the model the visual's id, so a fix can name it", async () => {
	const { run } = setup();
	const result = await run({ title: "Pie", html: "<p>pie</p>" });
	expect(result.content[0].text).toContain(result.details.visual.id);
});

test("a replacement takes the old visual's place: the shell is told which one, and the old file is removed", async () => {
	const { dataDir, sent, run } = setup();
	const old = (await run({ title: "Pie", html: "<script>broken(</script>" })).details.visual.id as string;
	const fixed = await run({ title: "Pie", html: "<p>pie</p>", replaces: old });
	const id = fixed.details.visual.id as string;
	expect(id).not.toBe(old);
	expect(fixed.details.visual.replaces).toBe(old);
	const show = sent.at(-1) as Extract<Request, { method: "visual_show" }>;
	expect(show.params).toMatchObject({ visualId: id, replaces: old });
	expect(readdirSync(join(dataDir, "visuals"))).toEqual([`${id}.html`]);
});

test("replacing an unknown visual is a clear error, and nothing is saved or shown", async () => {
	const { dataDir, sent, run } = setup();
	mkdirSync(join(dataDir, "visuals"), { recursive: true });
	writeFileSync(join(dataDir, "visuals", "notavisual.txt"), "x");
	await expect(run({ title: "Pie", html: "<p>pie</p>", replaces: "0123456789abcdef" })).rejects.toThrow(
		'There is no visual "0123456789abcdef" to replace',
	);
	await expect(run({ title: "Pie", html: "<p>pie</p>", replaces: "../secrets" })).rejects.toThrow("no visual");
	expect(sent).toHaveLength(0);
	expect(readdirSync(join(dataDir, "visuals"))).toEqual(["notavisual.txt"]);
	expect(existsSync(join(dataDir, "secrets"))).toBe(false);
});

const ts = (n: number) => new Date(1_000 + n).toISOString();
const message = (id: string, n: number, msg: Record<string, unknown>) =>
	({ type: "message", id, parentId: null, timestamp: ts(n), message: msg }) as unknown as SessionEntry;
const showCall = (id: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name: "show", arguments: args });
const showResult = (callId: string, visual: Record<string, unknown>) => ({
	role: "toolResult",
	toolCallId: callId,
	toolName: "show",
	content: [{ type: "text", text: "Showed" }],
	details: { visual },
	isError: false,
});

test("in the transcript, the replacement sits where the broken visual was, and the broken one is gone", () => {
	const A = "aaaaaaaaaaaaaaaa";
	const B = "bbbbbbbbbbbbbbbb";
	const entries = [
		message("u", 0, { role: "user", content: "chart it" }),
		message("a1", 1, { role: "assistant", content: [{ type: "text", text: "Here:" }, showCall("c1", { title: "Pie", html: "x" })] }),
		message("r1", 2, showResult("c1", { id: A, title: "Pie" })),
		message("a2", 3, { role: "assistant", content: [{ type: "text", text: "And the rest." }] }),
		message("a3", 4, { role: "assistant", content: [showCall("c2", { title: "Pie, fixed", html: "y", replaces: A })] }),
		message("r2", 5, showResult("c2", { id: B, title: "Pie, fixed", replaces: A })),
	];
	const items = transcriptItems(entries);
	const visuals = items.filter((i): i is Extract<TranscriptItem, { kind: "visual" }> => i.kind === "visual");
	expect(visuals.map((v) => [v.visualId, v.title])).toEqual([[B, "Pie, fixed"]]);
	expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "visual", "assistant", "tool"]);
});
