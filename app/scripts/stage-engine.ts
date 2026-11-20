// Builds winku-engine and copies it to where Tauri expects a sidecar:
// src-tauri/binaries/winku-engine-<rust target triple>[.exe]. Also stages the pinned
// agent-desktop CLI next to it (stage-agent-desktop.ts).
//
// It builds for this machine, or for the Rust target triple in WINKU_TARGET: the release builds
// the Intel Mac app (x86_64-apple-darwin) on an Apple Silicon runner.
import { $ } from "bun";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stageAgentDesktop, VERSION } from "./stage-agent-desktop.ts";

/** Bun's compile targets for the triples Winku ships. */
const BUN_TARGETS: Record<string, string> = {
	"x86_64-pc-windows-msvc": "bun-windows-x64",
	"x86_64-unknown-linux-gnu": "bun-linux-x64",
	"aarch64-unknown-linux-gnu": "bun-linux-arm64",
	"x86_64-apple-darwin": "bun-darwin-x64",
	"aarch64-apple-darwin": "bun-darwin-arm64",
};

const engineDir = join(import.meta.dir, "../../engine");
const binariesDir = join(import.meta.dir, "../src-tauri/binaries");
const host = (await $`rustc --print host-tuple`.text()).trim();
const triple = process.env.WINKU_TARGET?.trim() || host;
const exe = triple.includes("windows") ? ".exe" : "";

await $`bun install --frozen-lockfile`.cwd(engineDir);
if (triple === host) {
	await $`bun run build`.cwd(engineDir);
} else {
	const target = BUN_TARGETS[triple];
	if (!target) throw new Error(`No Bun target for ${triple}; known: ${Object.keys(BUN_TARGETS).join(", ")}`);
	await $`bun build --compile --minify --sourcemap --target=${target} src/main.ts --outfile ${`dist/winku-engine${exe}`}`.cwd(engineDir);
}

mkdirSync(binariesDir, { recursive: true });
copyFileSync(join(engineDir, "dist", `winku-engine${exe}`), join(binariesDir, `winku-engine-${triple}${exe}`));
console.log(`Staged winku-engine-${triple}${exe}`);

await stageAgentDesktop(triple);
console.log(`Staged agent-desktop ${VERSION} for ${triple} (SHA-256 checked)`);
