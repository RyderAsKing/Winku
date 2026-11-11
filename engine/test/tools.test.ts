// Unit tests for the agent tools: no engine process, no network (fetch and DNS are mocked).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RequestAborted, ShellRequests } from "../src/requests.ts";
import { dropCompactedImages, SCREENSHOT_REMOVED } from "../src/tools/images.ts";
import { classifyOpenTarget, type LaunchCommand, openCommand, openTool } from "../src/tools/open.ts";
import {
	checkPermission,
	DECLINED,
	describeCall,
	firstCommandWord,
	type GateDeps,
	isCompoundCommand,
	policyFrom,
} from "../src/tools/permission.ts";
import { chooseShells } from "../src/tools/shell.ts";
import {
	BRAVE_SEARCH_URL,
	braveSearch,
	checkPublicUrl,
	FETCH_MAX_BYTES,
	FETCH_MAX_CHARS,
	type FetchLike,
	fetchReadable,
	formatResults,
	htmlToText,
	isPrivateAddress,
	webSearchTool,
} from "../src/tools/web.ts";
import { toolSummary } from "../src/thread.ts";
import { removeTempDirs, tempDir } from "./harness.ts";

afterAll(removeTempDirs);

const noFetch: FetchLike = () => {
	throw new Error("network access in a test");
};
const publicDns = async () => ["93.184.215.14"];

// ───────────────────────────── shells ─────────────────────────────

test("shell tools: PowerShell on Windows, bash when found", () => {
	const none = () => {
		throw new Error("No bash shell found");
	};
	expect(chooseShells("win32", () => "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Windows")).toEqual({
		powershell: true,
		bash: "C:\\Program Files\\Git\\bin\\bash.exe",
	});
	expect(chooseShells("win32", none, "C:\\Windows")).toEqual({ powershell: true, bash: undefined });
	// The WSL launcher is not the user's bash.
	expect(chooseShells("win32", () => "C:\\Windows\\System32\\bash.exe", "C:\\Windows")).toEqual({ powershell: true, bash: undefined });
	expect(chooseShells("linux", () => "/bin/bash")).toEqual({ powershell: false, bash: "/bin/bash" });
	expect(chooseShells("darwin", () => "/bin/bash")).toEqual({ powershell: false, bash: "/bin/bash" });
	// Linux and macOS always get bash (pi falls back to sh).
	expect(chooseShells("linux", none)).toEqual({ powershell: false, bash: "/bin/sh" });
});

// ───────────────────────────── open ─────────────────────────────

test("open: http(s) only; other schemes are refused", () => {
	const home = tempDir("winku-open-");
	expect(classifyOpenTarget("https://example.com/a?b=1&c=2", home)).toEqual({ kind: "url", target: "https://example.com/a?b=1&c=2" });
	expect(classifyOpenTarget("HTTP://Example.com", home)).toEqual({ kind: "url", target: "http://example.com/" });
	for (const bad of [
		"file:///etc/passwd",
		"javascript:alert(1)",
		"ms-settings:privacy",
		"ms-msdt:/id",
		"mailto:a@b.c",
		"vbscript:x",
		"data:text/html,x",
		"search-ms:query=x",
		"shell:startup",
	])
		expect(() => classifyOpenTarget(bad, home)).toThrow();
});

test("open: paths must exist; app names can't carry shell syntax", () => {
	const home = tempDir("winku-open-");
	writeFileSync(join(home, "notes.txt"), "x");
	mkdirSync(join(home, "Downloads"));
	expect(classifyOpenTarget("notes.txt", home)).toEqual({ kind: "path", target: join(home, "notes.txt") });
	expect(classifyOpenTarget("~/Downloads", home)).toEqual({ kind: "path", target: join(home, "Downloads") });
	expect(classifyOpenTarget(join(home, "notes.txt"), home)).toEqual({ kind: "path", target: join(home, "notes.txt") });
	expect(() => classifyOpenTarget("~/missing.txt", home)).toThrow("No such file or folder");
	expect(() => classifyOpenTarget("\\\\server\\share\\x", home)).toThrow("UNC");
	expect(() => classifyOpenTarget("//server/share", home)).toThrow("UNC");
	expect(classifyOpenTarget("notepad", home)).toEqual({ kind: "app", target: "notepad" });
	expect(classifyOpenTarget("Visual Studio Code", home)).toEqual({ kind: "app", target: "Visual Studio Code" });
	for (const bad of ['calc" & del x', "calc & del x", "a|b", "a^b", "a<b", "a>b", "%COMSPEC%", "calc\nx", "-rf", "a;b", "a`b", "$(x)", ""])
		expect(() => classifyOpenTarget(bad, home, "win32")).toThrow();
});

test("open: launch commands never go through a shell for URLs or paths", () => {
	const url = { kind: "url", target: "https://example.com/?a=1&b=2" } as const;
	const path = { kind: "path", target: "C:\\Users\\x\\My notes.txt" } as const;
	const app = { kind: "app", target: "notepad" } as const;
	expect(openCommand(url, "win32")).toEqual({ command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url.target] });
	expect(openCommand(path, "win32")).toEqual({ command: "explorer.exe", args: [path.target] });
	expect(openCommand(app, "win32")).toEqual({ command: "cmd.exe", args: ["/d", "/c", "start", '""', '"notepad"'], verbatim: true });
	expect(openCommand(url, "linux")).toEqual({ command: "xdg-open", args: [url.target] });
	expect(openCommand(app, "darwin")).toEqual({ command: "open", args: ["-a", "notepad"] });
	expect(openCommand(path, "darwin")).toEqual({ command: "open", args: [path.target] });
});

test("open tool launches through the injected launcher", async () => {
	const home = tempDir("winku-open-");
	const launched: LaunchCommand[] = [];
	const tool = openTool(home, async (c) => void launched.push(c), "linux");
	const result = await tool.execute("t1", { target: "https://example.com" }, undefined, undefined, undefined as never);
	expect(result.content).toEqual([{ type: "text", text: "Opened https://example.com/" }]);
	expect(launched).toEqual([{ command: "xdg-open", args: ["https://example.com/"] }]);
	await expect(tool.execute("t2", { target: "javascript:alert(1)" }, undefined, undefined, undefined as never)).rejects.toThrow();
	expect(launched).toHaveLength(1);
});

// ───────────────────────────── web_fetch ─────────────────────────────

test("private, loopback and link-local addresses are recognised", () => {
	for (const ip of [
		"127.0.0.1",
		"10.1.2.3",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"224.0.0.1",
		"::1",
		"::",
		"fe80::1",
		"fd00::1",
		"fc00::5",
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		"::ffff:192.168.0.1",
		"64:ff9b::a00:1",
		"2002:c0a8:0101::1",
		"ff02::1",
	])
		expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
	for (const ip of ["93.184.215.14", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])
		expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
});

test("web_fetch refuses non-http(s) URLs and hosts that resolve into the local network", async () => {
	for (const url of ["file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)", "gopher://x"])
		await expect(checkPublicUrl(url, publicDns)).rejects.toThrow("Only http and https");
	for (const url of ["http://localhost:8080/", "http://printer.local/", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data"])
		await expect(checkPublicUrl(url, publicDns)).rejects.toThrow("Refusing");
	await expect(checkPublicUrl("http://intranet.example/", async () => ["10.0.0.5"])).rejects.toThrow("local network");
	// Any private address among the answers is enough to refuse.
	await expect(checkPublicUrl("http://mixed.example/", async () => ["93.184.215.14", "192.168.0.10"])).rejects.toThrow("local network");
	await expect(checkPublicUrl("http://nx.example/", async () => [])).rejects.toThrow("Could not resolve");
	expect((await checkPublicUrl("https://example.com/x", publicDns)).href).toBe("https://example.com/x");
	// Nothing was fetched for refused URLs.
	await expect(fetchReadable("http://127.0.0.1/", { fetch: noFetch, lookup: publicDns })).rejects.toThrow("Refusing");
});

test("web_fetch follows redirects only to public hosts", async () => {
	const seen: string[] = [];
	const fetchMock: FetchLike = async (url) => {
		seen.push(url);
		return new Response(null, { status: 302, headers: { location: "http://internal.example/admin" } });
	};
	const lookup = async (host: string) => (host === "internal.example" ? ["10.0.0.1"] : ["93.184.215.14"]);
	await expect(fetchReadable("https://example.com/", { fetch: fetchMock, lookup })).rejects.toThrow("local network");
	expect(seen).toEqual(["https://example.com/"]);
});

test("web_fetch turns HTML into readable text", async () => {
	const html = `<!doctype html><html><head><title>Tea &amp; Biscuits</title><style>body{color:red}</style>
		<script>alert("x")</script></head><body><nav><a href="/">Home</a> | <a href="/about">About</a></nav>
		<h1>Green tea</h1><p>Brew at <b>80&deg;C</b> &mdash; not boiling.</p>
		<ul><li>Sencha</li><li>Matcha</li></ul><p>See <a href="/guide">the guide</a> or <a href="https://other.example/x">this</a>.</p>
		<!-- hidden --><noscript>enable js</noscript></body></html>`;
	const fetchMock: FetchLike = async () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
	const page = await fetchReadable("https://tea.example/page", { fetch: fetchMock, lookup: publicDns });
	expect(page.title).toBe("Tea & Biscuits");
	expect(page.text).toContain("# Green tea");
	expect(page.text).toContain("Brew at 80&deg;C — not boiling.");
	expect(page.text).toContain("- Sencha\n- Matcha");
	expect(page.text).toContain("See the guide (https://tea.example/guide) or this (https://other.example/x).");
	for (const gone of ["alert", "color:red", "Home", "About", "hidden", "enable js"]) expect(page.text).not.toContain(gone);
	expect(page.truncated).toBe(false);
	expect(htmlToText("<p>a<br>b</p><table><tr><td>1</td><td>2</td></tr></table>").text).toBe("a\nb\n\n1 2");
});

test("web_fetch caps the download and the text", async () => {
	let pulled = 0;
	const chunk = new Uint8Array(64 * 1024).fill(97); // "a"
	const endless = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulled += chunk.byteLength;
			controller.enqueue(chunk);
		},
	});
	const fetchMock: FetchLike = async () => new Response(endless, { headers: { "content-type": "text/plain" } });
	const page = await fetchReadable("https://big.example/", { fetch: fetchMock, lookup: publicDns });
	expect(page.text.length).toBe(FETCH_MAX_CHARS);
	expect(page.truncated).toBe(true);
	// Reading stopped at the cap (plus whatever the stream had buffered ahead).
	expect(pulled).toBeLessThan(FETCH_MAX_BYTES + 4 * chunk.byteLength);

	const binary: FetchLike = async () => new Response(new Uint8Array(10), { headers: { "content-type": "application/pdf" } });
	await expect(fetchReadable("https://pdf.example/", { fetch: binary, lookup: publicDns })).rejects.toThrow("Can't read application/pdf");
	const missing: FetchLike = async () => new Response("nope", { status: 404, statusText: "Not Found" });
	await expect(fetchReadable("https://x.example/", { fetch: missing, lookup: publicDns })).rejects.toThrow("404");
});

test("web_fetch stops when the call is aborted", async () => {
	let started!: () => void;
	const fetching = new Promise<void>((resolve) => {
		started = resolve;
	});
	const hang: FetchLike = (_url, init) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			started();
		});
	const controller = new AbortController();
	const pending = fetchReadable("https://slow.example/", { fetch: hang, lookup: publicDns }, controller.signal);
	await fetching;
	controller.abort();
	await expect(pending).rejects.toThrow("aborted");
	// Already aborted: no request at all.
	await expect(fetchReadable("https://x.example/", { fetch: noFetch, lookup: publicDns }, controller.signal)).rejects.toThrow();
});

// ───────────────────────────── web_search ─────────────────────────────

test("web_search calls Brave with the key and formats the top results", async () => {
	const calls: { url: string; headers: Record<string, string> }[] = [];
	const fetchMock: FetchLike = async (url, init) => {
		calls.push({ url, headers: init?.headers as Record<string, string> });
		return Response.json({
			web: {
				results: Array.from({ length: 10 }, (_, i) => ({
					title: `Result <strong>${i + 1}</strong>`,
					url: `https://r${i + 1}.example/`,
					description: `About <strong>tea</strong> &amp; more ${i + 1}`,
				})),
			},
		});
	};
	const results = await braveSearch("green tea", "sk-test", { fetch: fetchMock });
	expect(calls).toHaveLength(1);
	const url = new URL(calls[0]?.url ?? "");
	expect(`${url.origin}${url.pathname}`).toBe(BRAVE_SEARCH_URL);
	expect(url.searchParams.get("q")).toBe("green tea");
	expect(calls[0]?.headers["X-Subscription-Token"]).toBe("sk-test");
	expect(results).toHaveLength(8);
	expect(results[0]).toEqual({ title: "Result 1", url: "https://r1.example/", snippet: "About tea & more 1" });
	expect(formatResults(results.slice(0, 2))).toBe(
		"1. Result 1\n   https://r1.example/\n   About tea & more 1\n\n2. Result 2\n   https://r2.example/\n   About tea & more 2",
	);
	expect(formatResults([])).toBe("No results.");

	const rejected: FetchLike = async () => new Response("", { status: 401 });
	await expect(braveSearch("x", "bad", { fetch: rejected })).rejects.toThrow("search key was rejected");
	const tool = webSearchTool(() => undefined, { fetch: noFetch });
	await expect(tool.execute("t", { query: "x" }, undefined, undefined, undefined as never)).rejects.toThrow("not set up");
});

// ───────────────────────────── permission ─────────────────────────────

test("allowKeys and summaries", () => {
	expect(firstCommandWord("Remove-Item C:\\tmp -Recurse")).toBe("Remove-Item");
	expect(firstCommandWord('& "C:\\Program Files\\x.exe" -a')).toBe("C:\\Program Files\\x.exe");
	expect(firstCommandWord("FOO=1 BAR=2 git status")).toBe("git");
	expect(firstCommandWord("  ls -la")).toBe("ls");
	expect(isCompoundCommand("Get-ChildItem Downloads")).toBe(false);
	for (const c of ["ls; rm -rf ~", "a && b", "a | b", "echo x > f", "echo $(rm x)", "echo `x`", "a\nb", "a & b"])
		expect([c, isCompoundCommand(c)]).toEqual([c, true]);
	const home = "/home/u";
	expect(describeCall("powershell", { command: "Remove-Item C:\\tmp -Recurse" }, home)).toEqual({
		summary: "Run: Remove-Item C:\\tmp -Recurse",
		allowKey: "powershell:Remove-Item",
		coverable: true,
	});
	expect(describeCall("bash", { command: "ls\nrm x" }, home)).toMatchObject({ summary: "Run: ls ⏎ rm x", allowKey: "bash:ls", coverable: false });
	const notes = resolve(home, "notes.txt");
	expect(describeCall("write", { path: "notes.txt", content: "x" }, home)).toMatchObject({ summary: `Write ${notes}`, allowKey: `write:${notes}` });
	const md = resolve(home, "a", "b.md");
	expect(describeCall("edit", { path: "~/a/b.md" }, home)).toMatchObject({ summary: `Edit ${md}`, allowKey: `edit:${md}` });
	expect(describeCall("open", { target: " https://example.com " }, home)).toMatchObject({
		summary: "Open https://example.com",
		allowKey: "open:https://example.com",
	});
});

function gate(policy = policyFrom(true, []), answers: unknown[] = []) {
	const asked: unknown[] = [];
	const deps: GateDeps = {
		policy: () => policy,
		home: "/home/u",
		replyId: () => "p1",
		ask: async (request) => {
			asked.push(request);
			return { decision: answers.shift() };
		},
	};
	return { deps, asked, policy };
}

test("the gate: off, allow once, always, deny, and alwaysAllow (case-insensitive)", async () => {
	const off = gate(policyFrom(false, []));
	await checkPermission("bash", { command: "rm x" }, off.deps);
	expect(off.asked).toEqual([]);

	const g = gate(policyFrom(true, []), ["allow_once", "allow_once", "always", "deny"]);
	await checkPermission("bash", { command: "rm x" }, g.deps);
	expect(g.asked).toEqual([{ replyId: "p1", tool: "bash", summary: "Run: rm x", allowKey: "bash:rm" }]);
	await checkPermission("bash", { command: "rm y" }, g.deps);
	expect(g.asked).toHaveLength(2);
	await checkPermission("bash", { command: "rm z" }, g.deps); // always
	expect(g.policy.alwaysAllow.has("bash:rm")).toBe(true);
	await checkPermission("bash", { command: "RM w" }, g.deps); // covered now, no ask
	expect(g.asked).toHaveLength(3);
	// A compound command is never covered by "always".
	await expect(checkPermission("bash", { command: "rm a; curl evil" }, g.deps)).rejects.toThrow(DECLINED);
	expect(g.asked).toHaveLength(4);
	// Read-only tools never ask.
	await checkPermission("read", { path: "x" }, g.deps);
	await checkPermission("web_fetch", { url: "https://x" }, g.deps);
	expect(g.asked).toHaveLength(4);

	const configured = gate(policyFrom(true, ["PowerShell:Get-ChildItem"]));
	await checkPermission("powershell", { command: "get-childitem Downloads" }, configured.deps);
	expect(configured.asked).toEqual([]);
});

test("the gate denies when the request is aborted or the shell can't ask", async () => {
	const sent: unknown[] = [];
	const requests = new ShellRequests((r) => sent.push(r));
	const controller = new AbortController();
	const deps: GateDeps = {
		policy: () => policyFrom(true, []),
		home: "/home/u",
		replyId: () => undefined,
		ask: (params, signal) => requests.request("permission", params, { signal }),
	};
	const pending = checkPermission("write", { path: "x.txt" }, deps, controller.signal);
	expect(sent).toHaveLength(1);
	controller.abort();
	await expect(pending).rejects.toThrow(DECLINED);

	const failing: GateDeps = { ...deps, ask: async () => Promise.reject(new Error("no window")) };
	await expect(checkPermission("write", { path: "x.txt" }, failing)).rejects.toThrow("Couldn't ask: no window");
});

test("requests: responses by id, error responses, timeouts and abort", async () => {
	const sent: { id: string }[] = [];
	const requests = new ShellRequests((r) => sent.push(r as { id: string }));
	const a = requests.request("screen_capture", { includeImage: false });
	const b = requests.request("screen_capture", { includeImage: true });
	requests.handle({ type: "response", id: sent[1]?.id ?? "", ok: true, data: { app: "b" } });
	requests.handle({ type: "response", id: sent[0]?.id ?? "", ok: false, error: "nope" });
	expect(await b).toEqual({ app: "b" });
	await expect(a).rejects.toThrow("nope");
	requests.handle({ type: "response", id: "unknown", ok: true }); // ignored
	await expect(requests.request("screen_capture", { includeImage: false }, { timeoutMs: 10 })).rejects.toThrow("did not answer");
	const controller = new AbortController();
	controller.abort();
	await expect(requests.request("screen_capture", { includeImage: false }, { signal: controller.signal })).rejects.toBeInstanceOf(RequestAborted);
});

// ───────────────────────────── summaries and images ─────────────────────────────

test("tool summaries read well", () => {
	expect(toolSummary("powershell", { command: "Get-ChildItem Downloads" })).toBe("Get-ChildItem Downloads");
	expect(toolSummary("bash", { command: "ls -la\necho done" })).toBe("ls -la");
	expect(toolSummary("write", { path: "C:\\Users\\x\\notes.txt", content: "…" })).toBe("notes.txt");
	expect(toolSummary("read", { path: "/home/x/notes.txt" })).toBe("notes.txt");
	expect(toolSummary("web_fetch", { url: "https://example.com" })).toBe("https://example.com");
	expect(toolSummary("web_search", { query: "green tea" })).toBe("green tea");
	expect(toolSummary("open", { target: "notepad" })).toBe("notepad");
	expect(toolSummary("look_at_screen", {})).toBe("the active window");
	expect(toolSummary("grep", { pattern: "TODO", path: "src" })).toBe("TODO in src");
	expect(toolSummary("ls", {})).toBe("~");
});

test("images kept by a compaction are replaced; later ones stay", () => {
	const image = { type: "image", data: "AAAA", mimeType: "image/png" };
	const messages = [
		{ role: "system", content: "prompt", timestamp: 1 },
		{ role: "compactionSummary", summary: "s", tokensBefore: 10, timestamp: 100 },
		{ role: "user", content: [{ type: "text", text: "look" }, image], timestamp: 50 },
		{ role: "toolResult", toolCallId: "t", toolName: "look_at_screen", content: [{ type: "text", text: "App" }, image], isError: false, timestamp: 60 },
		{ role: "user", content: [{ type: "text", text: "new" }, image], timestamp: 150 },
	] as never[];
	const out = dropCompactedImages(messages) as { content: unknown }[];
	expect(out[2]?.content).toEqual([{ type: "text", text: "look" }, { type: "text", text: SCREENSHOT_REMOVED }]);
	expect(out[3]?.content).toEqual([{ type: "text", text: "App" }, { type: "text", text: SCREENSHOT_REMOVED }]);
	expect(out[4]?.content).toEqual([{ type: "text", text: "new" }, image]);
	// Without a compaction nothing changes.
	const plain = messages.filter((m) => (m as { role: string }).role !== "compactionSummary");
	expect(dropCompactedImages(plain)).toBe(plain);
});
