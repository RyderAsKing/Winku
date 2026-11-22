// Provider extensions: pi packages the user installs to get more model providers (for example
// pi-claude-code, which uses a Claude subscription through the Claude Code CLI).
//
// They live in <dataDir>/extensions/, a package folder of their own, installed by this binary acting
// as Bun (BUN_BE_BUN), so no npm, git or pi install is needed. Peer dependencies are skipped (pi's
// packages come from inside the engine, through pi's loader) and install scripts never run.
// Only the providers an extension registers are used; its tools, commands and hooks are not.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Api, Provider } from "@earendil-works/pi-ai";
import { discoverAndLoadExtensions, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ExtensionInfo } from "./protocol.ts";

type ProviderConfigInput = Parameters<ModelRuntime["registerProvider"]>[1];

/** What one extension registered. */
interface LoadedExtension {
	name: string;
	natives: Provider<Api>[];
	configs: { name: string; config: ProviderConfigInput }[];
	error?: string;
}

const INSTALL_TIMEOUT_MS = 50_000;

let dataDir: string | undefined = process.env.WINKU_DATA_DIR || undefined;
let loaded: Promise<LoadedExtension[]> | undefined;
/** Installs and removals run one at a time. */
let queue: Promise<unknown> = Promise.resolve();

/** configure's dataDir, for an engine started without WINKU_DATA_DIR. */
export function setExtensionsDataDir(dir: string): void {
	if (dataDir === dir) return;
	dataDir = dir;
	loaded = undefined;
}

function folder(): string | undefined {
	return dataDir ? join(dataDir, "extensions") : undefined;
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** Installed package name → what it was installed from. */
function installed(dir: string): Record<string, string> {
	const deps = readJson(join(dir, "package.json"))?.dependencies;
	return deps && typeof deps === "object" ? (deps as Record<string, string>) : {};
}

function packageDir(dir: string, name: string): string {
	return join(dir, "node_modules", ...name.split("/"));
}

/** What the user typed, as `bun add` takes it. */
export function installSpec(source: string): string {
	const s = source.trim();
	if (!s) throw new Error("Enter a package name, a GitHub URL or a folder");
	const github = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/?#]+))?\/?(?:[?#].*)?$/i.exec(s);
	if (github) return `github:${github[1]}/${github[2]}${github[3] ? `#${github[3]}` : ""}`;
	if (s.startsWith("npm:")) return s.slice(4);
	if (isAbsolute(s) || s.startsWith("file:")) return s;
	if (s.startsWith("./") || s.startsWith("../") || s.startsWith("~")) throw new Error("Use the folder's full path");
	return s;
}

async function loadOne(dir: string, name: string): Promise<LoadedExtension> {
	const root = packageDir(dir, name);
	if (!existsSync(root)) return { name, natives: [], configs: [], error: "Not installed. Remove it and install it again." };
	try {
		// Both discovery folders point inside extensions/, where pi's .pi/extensions and extensions/ never
		// exist, so only the package itself loads: nothing from ~/.pi or any project.
		const result = await discoverAndLoadExtensions([root], dir, join(dir, ".agent"));
		const natives = result.runtime.pendingNativeProviderRegistrations.map((r) => r.provider);
		const configs = result.runtime.pendingProviderRegistrations.map(({ name, config }) => ({ name, config }));
		const error = result.errors.map((e) => e.error).join("; ") || (result.extensions.length ? undefined : "It has no pi extension in it.");
		return { name, natives, configs, ...(error ? { error } : {}) };
	} catch (error) {
		return { name, natives: [], configs: [], error: error instanceof Error ? error.message : String(error) };
	}
}

function loadAll(): Promise<LoadedExtension[]> {
	const dir = folder();
	if (!dir) return Promise.resolve([]);
	loaded ??= Promise.all(Object.keys(installed(dir)).map((name) => loadOne(dir, name)));
	return loaded;
}

function providersOf(ext: LoadedExtension): { id: string; name: string }[] {
	return [
		...ext.natives.map((p) => ({ id: p.id, name: p.name ?? p.id })),
		...ext.configs.map((c) => ({ id: c.name, name: (c.config as { name?: string }).name ?? c.name })),
	];
}

/** Register every installed extension's providers on a runtime. Returns provider id → package name. */
export async function registerExtensionProviders(runtime: ModelRuntime): Promise<Map<string, string>> {
	const owners = new Map<string, string>();
	for (const ext of await loadAll()) {
		for (const provider of ext.natives) {
			try {
				runtime.registerNativeProvider(provider);
				owners.set(provider.id, ext.name);
			} catch (error) {
				console.error(`winku-engine: extension ${ext.name}: ${error instanceof Error ? error.message : error}`);
			}
		}
		for (const { name, config } of ext.configs) {
			try {
				runtime.registerProvider(name, config);
				owners.set(name, ext.name);
			} catch (error) {
				console.error(`winku-engine: extension ${ext.name}: ${error instanceof Error ? error.message : error}`);
			}
		}
	}
	return owners;
}

function info(dir: string, ext: LoadedExtension): ExtensionInfo {
	const pkg = readJson(join(packageDir(dir, ext.name), "package.json")) ?? {};
	return {
		name: ext.name,
		...(typeof pkg.version === "string" ? { version: pkg.version } : {}),
		...(typeof pkg.description === "string" ? { description: pkg.description } : {}),
		source: installed(dir)[ext.name] ?? "",
		providers: providersOf(ext),
		...(ext.error ? { error: ext.error } : {}),
	};
}

export async function listExtensions(): Promise<ExtensionInfo[]> {
	const dir = folder();
	if (!dir) return [];
	return (await loadAll()).map((ext) => info(dir, ext));
}

/** The package that adds a provider id, if an extension does. */
export async function extensionOf(providerId: string): Promise<string | undefined> {
	return (await loadAll()).find((ext) => providersOf(ext).some((p) => p.id === providerId))?.name;
}

/** Run this binary as Bun in the extensions folder. */
async function bun(dir: string, args: string[]): Promise<void> {
	const proc = Bun.spawn([process.execPath, ...args], {
		cwd: dir,
		env: { ...process.env, BUN_BE_BUN: "1" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill(), INSTALL_TIMEOUT_MS);
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	clearTimeout(timer);
	if (code === 0) return;
	const lines = `${err}\n${out}`
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => /error/i.test(l));
	throw new Error(proc.signalCode ? "The install took too long. Check your connection and try again." : lines.slice(-2).join(" ") || `bun ${args[0]} failed (${code})`);
}

function serially<T>(task: () => Promise<T>): Promise<T> {
	const run = queue.then(task, task);
	queue = run.catch(() => {});
	return run;
}

function ensureFolder(): string {
	const dir = folder();
	if (!dir) throw new Error("The engine has no data folder yet");
	mkdirSync(dir, { recursive: true });
	const manifest = join(dir, "package.json");
	if (!existsSync(manifest)) writeFileSync(manifest, `${JSON.stringify({ name: "winku-extensions", private: true }, null, "\t")}\n`);
	return dir;
}

export function installExtension(source: string, builtIn: (id: string) => boolean): Promise<ExtensionInfo> {
	return serially(async () => {
		const spec = installSpec(source);
		const dir = ensureFolder();
		const before = installed(dir);
		await bun(dir, ["add", "--omit", "peer", "--ignore-scripts", spec]);
		const after = installed(dir);
		const added = Object.keys(after).filter((name) => before[name] !== after[name]);
		const name = added[0] ?? Object.keys(after).find((n) => after[n] === spec);
		loaded = undefined;
		if (!name) throw new Error("The package installed, but Winku couldn't tell which one it was");
		const ext = await loadOne(dir, name);
		const providers = providersOf(ext);
		const others = (await loadAll()).filter((e) => e.name !== name).flatMap(providersOf);
		const clash = providers.find((p) => builtIn(p.id) || others.some((o) => o.id === p.id));
		const problem = ext.error
			? `It didn't load: ${ext.error}`
			: providers.length === 0
				? "It doesn't add a model provider, and Winku only uses extensions for providers."
				: clash
					? `It adds the provider "${clash.id}", which Winku already has.`
					: undefined;
		if (problem) {
			if (before[name] === undefined) await bun(dir, ["remove", name]).catch(() => {});
			loaded = undefined;
			throw new Error(problem);
		}
		return info(dir, ext);
	});
}

export function removeExtension(name: string): Promise<void> {
	return serially(async () => {
		const dir = folder();
		if (!dir || installed(dir)[name] === undefined) throw new Error(`"${name}" isn't installed`);
		await bun(dir, ["remove", name]);
		loaded = undefined;
	});
}
