// web_fetch and web_search. Only http(s), never into the local network.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const FETCH_TIMEOUT_MS = 15_000;
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_MAX_CHARS = 20_000;
const MAX_REDIRECTS = 5;
export const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface WebDeps {
	fetch: FetchLike;
	/** All addresses for a host name. */
	lookup: (host: string) => Promise<string[]>;
}

export const defaultWebDeps: WebDeps = {
	fetch: (input, init) => fetch(input, init),
	lookup: async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address),
};

// ───────────────────────────── addresses ─────────────────────────────

function ipv4Private(ip: string): boolean {
	const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0 && c === 0) ||
		(a === 192 && b === 0 && c === 2) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	);
}

/** Expand an IPv6 address to eight 16-bit groups. */
function ipv6Groups(ip: string): number[] | undefined {
	let s = ip.toLowerCase().replace(/^\[|\]$/g, "");
	const zone = s.indexOf("%");
	if (zone !== -1) s = s.slice(0, zone);
	// Trailing dotted IPv4 (::ffff:1.2.3.4).
	const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
	if (v4?.[1]) {
		const [a = 0, b = 0, c = 0, d = 0] = v4[1].split(".").map(Number);
		s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = s.split("::");
	if (halves.length > 2) return undefined;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
	const parts = [...head, ...Array(Math.max(0, fill)).fill("0"), ...tail];
	if (parts.length !== 8) return undefined;
	const groups = parts.map((p) => Number.parseInt(p, 16));
	return groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff) ? undefined : groups;
}

function v4FromGroups(hi: number, lo: number): string {
	return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** Loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses (v4 and v6). */
export function isPrivateAddress(ip: string): boolean {
	const kind = isIP(ip.replace(/^\[|\]$/g, "").replace(/%.*$/, ""));
	if (kind === 4) return ipv4Private(ip);
	const g = ipv6Groups(ip);
	if (!g) return true;
	const [g0 = 0, , , , , g5 = 0, g6 = 0, g7 = 0] = g;
	if (g.every((x) => x === 0)) return true; // ::
	if (g.slice(0, 7).every((x) => x === 0) && g7 === 1) return true; // ::1
	if (g.slice(0, 5).every((x) => x === 0) && (g5 === 0xffff || g5 === 0)) return ipv4Private(v4FromGroups(g6, g7)); // v4-mapped / compatible
	if (g0 === 0x64 && g[1] === 0xff9b) return ipv4Private(v4FromGroups(g6, g7)); // NAT64
	if (g0 === 0x2002) return ipv4Private(v4FromGroups(g[1] ?? 0, g[2] ?? 0)); // 6to4
	if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
	if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
	if ((g0 & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
	if ((g0 & 0xff00) === 0xff00) return true; // multicast
	if (g0 === 0x2001 && g[1] === 0xdb8) return true; // documentation
	return false;
}

/** Throws unless the URL is http(s) and its host resolves only to public addresses. */
export async function checkPublicUrl(raw: string, lookup: WebDeps["lookup"]): Promise<URL> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("That is not a valid URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https URLs can be fetched, not ${url.protocol}`);
	const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
	if (!host) throw new Error("That URL has no host");
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))
		throw new Error(`Refusing to fetch ${host}: it is on the local network`);
	const addresses = isIP(host) ? [host] : await lookup(host).catch(() => {
		throw new Error(`Could not resolve ${host}`);
	});
	if (addresses.length === 0) throw new Error(`Could not resolve ${host}`);
	if (addresses.some(isPrivateAddress)) throw new Error(`Refusing to fetch ${host}: it points into the local network`);
	return url;
}

// ───────────────────────────── HTML → text ─────────────────────────────

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	hellip: "…",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	copy: "©",
	reg: "®",
	trade: "™",
	middot: "·",
	bull: "•",
	laquo: "«",
	raquo: "»",
};

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
		if (code[0] === "#") {
			const n = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
		}
		return ENTITIES[code.toLowerCase()] ?? whole;
	});
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, "");

/** Readable text from HTML: drops scripts, styles and navigation; keeps headings, list items and links as text. */
export function htmlToText(html: string, baseUrl?: string): { title: string; text: string } {
	let s = html.replace(/<!--[\s\S]*?-->/g, "");
	const title = decodeEntities(stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1] ?? "")).replace(/\s+/g, " ").trim();
	s = s.replace(/<(script|style|noscript|nav|svg|iframe|template|head|form|button|select)\b[\s\S]*?<\/\1\s*>/gi, "");
	s = s.replace(/<(script|style|link|meta|input|img)\b[^>]*>/gi, "");
	s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, level: string, inner: string) => {
		const text = stripTags(inner).replace(/\s+/g, " ").trim();
		return text ? `\n\n${"#".repeat(Number(level))} ${text}\n\n` : "";
	});
	s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_m, attrs: string, inner: string) => {
		const text = stripTags(inner).replace(/\s+/g, " ").trim();
		const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
		let link = decodeEntities(href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
		if (!text) return "";
		if (!link || link.startsWith("#") || /^javascript:/i.test(link)) return text;
		try {
			link = new URL(link, baseUrl).href;
		} catch {}
		return link === text ? text : `${text} (${link})`;
	});
	s = s.replace(/<li\b[^>]*>/gi, "\n- ");
	s = s.replace(/<br\s*\/?>/gi, "\n");
	s = s.replace(/<\/?(p|div|section|article|main|header|footer|aside|ul|ol|table|tr|blockquote|pre|dl|dt|dd|figure|figcaption|h[1-6])\b[^>]*>/gi, "\n");
	s = s.replace(/<\/t[dh]\s*>/gi, "\t");
	s = decodeEntities(stripTags(s));
	const text = s
		.split("\n")
		.map((line) => line.replace(/[ \t ]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { title, text };
}

// ───────────────────────────── fetch ─────────────────────────────

async function readCapped(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	const reader = response.body?.getReader();
	if (!reader) return { bytes: new Uint8Array(), truncated: false };
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (size + value.byteLength > maxBytes) {
			chunks.push(value.subarray(0, maxBytes - size));
			size = maxBytes;
			truncated = true;
			await reader.cancel().catch(() => {});
			break;
		}
		chunks.push(value);
		size += value.byteLength;
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, truncated };
}

function charsetOf(contentType: string): string {
	const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? "utf-8";
	try {
		new TextDecoder(charset);
		return charset;
	} catch {
		return "utf-8";
	}
}

export interface FetchedPage {
	url: string;
	title: string;
	text: string;
	truncated: boolean;
}

/** GET a public http(s) URL (following up to 5 redirects, each checked) and return readable text. */
export async function fetchReadable(raw: string, deps: WebDeps, signal?: AbortSignal): Promise<FetchedPage> {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let url = await checkPublicUrl(raw, deps.lookup);
	let response: Response | undefined;
	try {
		for (let hop = 0; ; hop++) {
			combined.throwIfAborted();
			response = await deps.fetch(url.href, {
				redirect: "manual",
				signal: combined,
				headers: { "User-Agent": "Winku/1.0 (desktop assistant)", Accept: "text/html,text/plain,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5" },
			});
			if (response.status < 300 || response.status >= 400 || response.status === 304) break;
			const location = response.headers.get("location");
			if (!location) break;
			if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects");
			await response.body?.cancel().catch(() => {});
			url = await checkPublicUrl(new URL(location, url).href, deps.lookup);
		}
		if (!response.ok) throw new Error(`The server answered ${response.status} ${response.statusText}`.trim());
		const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
		const textual = !contentType || /^text\/|html|xml|json|javascript/.test(contentType);
		if (!textual) {
			await response.body?.cancel().catch(() => {});
			throw new Error(`Can't read ${contentType.split(";")[0]} content as text`);
		}
		const { bytes, truncated: cut } = await readCapped(response, FETCH_MAX_BYTES);
		const body = new TextDecoder(charsetOf(contentType)).decode(bytes);
		const isHtml = contentType.includes("html") || (!contentType && /^\s*<(!doctype|html)/i.test(body));
		const { title, text } = isHtml ? htmlToText(body, url.href) : { title: "", text: body.trim() };
		const truncated = cut || text.length > FETCH_MAX_CHARS;
		return { url: url.href, title, text: text.slice(0, FETCH_MAX_CHARS), truncated };
	} catch (error) {
		if (timeout.aborted && !signal?.aborted) throw new Error("The page took too long to load");
		throw error;
	}
}

export function webFetchTool(deps: WebDeps = defaultWebDeps) {
	return defineTool({
		name: "web_fetch",
		label: "Fetch web page",
		description:
			"Fetch a public web page (http or https) and return its readable text, with headings and links kept as text. " +
			`Long pages are cut at ${FETCH_MAX_CHARS.toLocaleString("en-US")} characters. Can't reach the local network.`,
		parameters: Type.Object({
			url: Type.String({ description: "The http(s) URL to fetch" }),
		}),
		async execute(_id, params, signal) {
			const page = await fetchReadable(params.url, deps, signal);
			const header = [page.title ? `# ${page.title}` : "", `URL: ${page.url}`].filter(Boolean).join("\n");
			const text = `${header}\n\n${page.text || "(no readable text)"}${page.truncated ? "\n\n[truncated]" : ""}`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	});
}

// ───────────────────────────── search ─────────────────────────────

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

const clean = (s: unknown) => (typeof s === "string" ? decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim() : "");

export async function braveSearch(query: string, key: string, deps: Pick<WebDeps, "fetch">, signal?: AbortSignal, count = 8): Promise<SearchResult[]> {
	const url = new URL(BRAVE_SEARCH_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(count));
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const response = await deps.fetch(url.href, {
		headers: { Accept: "application/json", "X-Subscription-Token": key },
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (response.status === 401 || response.status === 403) throw new Error("The search key was rejected (check it in Settings)");
	if (response.status === 429) throw new Error("Search rate limit reached; try again shortly");
	if (!response.ok) throw new Error(`Search failed: ${response.status} ${response.statusText}`.trim());
	const data = (await response.json()) as { web?: { results?: { title?: unknown; url?: unknown; description?: unknown }[] } };
	return (data.web?.results ?? [])
		.slice(0, count)
		.map((r) => ({ title: clean(r.title), url: typeof r.url === "string" ? r.url : "", snippet: clean(r.description) }))
		.filter((r) => r.url);
}

export function formatResults(results: SearchResult[]): string {
	if (results.length === 0) return "No results.";
	return results.map((r, i) => `${i + 1}. ${r.title || r.url}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n");
}

export function webSearchTool(key: () => string | undefined, deps: Pick<WebDeps, "fetch"> = defaultWebDeps) {
	return defineTool({
		name: "web_search",
		label: "Search the web",
		description: "Search the web. Returns the top results with title, URL and a snippet; use web_fetch to read a page.",
		parameters: Type.Object({
			query: Type.String({ description: "What to search for" }),
		}),
		async execute(_id, params, signal) {
			const apiKey = key();
			if (!apiKey) throw new Error("Web search is not set up (no search key)");
			const results = await braveSearch(params.query, apiKey, deps, signal);
			return { content: [{ type: "text", text: formatResults(results) }], details: undefined };
		},
	});
}
