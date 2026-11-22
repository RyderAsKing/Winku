// Provider extensions through the real engine process: install from a local folder, offer the
// provider, refuse what isn't a provider, and keep one that is in use. No network.
import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installSpec } from "../src/extensions.ts";
import type { ExtensionInfo, ModelInfo, ProviderInfo } from "../src/protocol.ts";
import { EngineProcess, removeTempDirs } from "./harness.ts";

const T = 30_000;
const FIXTURES = join(import.meta.dir, "fixtures");
const running: EngineProcess[] = [];

function start(): EngineProcess {
	const engine = EngineProcess.start();
	running.push(engine);
	return engine;
}
afterAll(removeTempDirs);
afterEach(async () => {
	// Wait for each to exit: Windows keeps the temp folder locked while the process lives.
	for (const engine of running.splice(0)) {
		try {
			engine.proc.kill();
		} catch {}
		await engine.proc.exited;
	}
});

test("installSpec reads what people paste", () => {
	expect(installSpec("https://github.com/earendil-works/pi-claude-code")).toBe("github:earendil-works/pi-claude-code");
	expect(installSpec("https://github.com/earendil-works/pi-claude-code.git")).toBe("github:earendil-works/pi-claude-code");
	expect(installSpec("https://github.com/o/r/tree/v1.0")).toBe("github:o/r#v1.0");
	expect(installSpec(" npm:@earendil-works/pi-claude-code ")).toBe("@earendil-works/pi-claude-code");
	expect(installSpec("some-package@2")).toBe("some-package@2");
	expect(installSpec("github:o/r")).toBe("github:o/r");
	expect(() => installSpec("")).toThrow();
	expect(() => installSpec("./relative")).toThrow("full path");
});

test("installs a provider extension and offers its provider", async () => {
	const engine = start();
	expect(await engine.callOk<ExtensionInfo[]>({ type: "extensions_list" })).toEqual([]);

	const info = await engine.callOk<ExtensionInfo>({ type: "extension_install", source: join(FIXTURES, "provider-extension") });
	expect(info).toMatchObject({
		name: "winku-test-provider",
		version: "1.2.3",
		description: "A provider extension for the engine tests",
		providers: [{ id: "test-ext", name: "Test Extension Provider" }],
	});
	expect(info.error).toBeUndefined();
	// Installed into the data folder, without pi's packages (they come from inside the engine).
	const folder = join(engine.dataDir, "extensions");
	expect(existsSync(join(folder, "node_modules", "winku-test-provider", "index.ts"))).toBe(true);
	expect(existsSync(join(folder, "node_modules", "@earendil-works"))).toBe(false);
	expect(JSON.parse(readFileSync(join(folder, "package.json"), "utf8")).dependencies).toHaveProperty("winku-test-provider");

	const providers = await engine.callOk<ProviderInfo[]>({ type: "list_providers" });
	expect(providers.find((p) => p.id === "test-ext")).toEqual({
		id: "test-ext",
		name: "Test Extension Provider",
		extension: "winku-test-provider",
		signedIn: expect.any(String),
	});
	expect(providers.find((p) => p.id === "anthropic")?.extension).toBeUndefined();

	const models = await engine.callOk<ModelInfo[]>({ type: "list_models", provider: { kind: "catalog", id: "test-ext" } });
	expect(models.map((m) => m.id)).toEqual(["ext-model"]);

	// A restarted engine finds it again.
	await engine.shutdown();
	const again = engine.restart();
	running.push(again);
	expect((await again.callOk<ExtensionInfo[]>({ type: "extensions_list" })).map((e) => e.name)).toEqual(["winku-test-provider"]);
}, T);

test("turns away an extension that adds no provider", async () => {
	const engine = start();
	const result = await engine.call({ type: "extension_install", source: join(FIXTURES, "tool-extension") });
	expect(result.ok).toBe(false);
	expect(result.error).toContain("doesn't add a model provider");
	expect(await engine.callOk<ExtensionInfo[]>({ type: "extensions_list" })).toEqual([]);
}, T);

test("keeps an extension while the configured provider comes from it", async () => {
	const engine = start();
	await engine.callOk({ type: "extension_install", source: join(FIXTURES, "provider-extension") });
	await engine.configure({ provider: { kind: "catalog", id: "test-ext" }, main: { id: "ext-model", thinking: "off" } });

	const refused = await engine.call({ type: "extension_remove", name: "winku-test-provider" });
	expect(refused.ok).toBe(false);
	expect(refused.error).toContain("Pick another provider");

	await engine.configure();
	await engine.callOk({ type: "extension_remove", name: "winku-test-provider" });
	expect(await engine.callOk<ExtensionInfo[]>({ type: "extensions_list" })).toEqual([]);
	expect((await engine.callOk<ProviderInfo[]>({ type: "list_providers" })).some((p) => p.id === "test-ext")).toBe(false);
}, T);
