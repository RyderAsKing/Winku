// Builds winku-engine for this machine and copies it to where Tauri expects a sidecar:
// src-tauri/binaries/winku-engine-<rust target triple>[.exe]
import { $ } from "bun";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const engineDir = join(import.meta.dir, "../../engine");
const binariesDir = join(import.meta.dir, "../src-tauri/binaries");
const triple = (await $`rustc --print host-tuple`.text()).trim();
const windows = process.platform === "win32";
const exe = windows ? ".exe" : "";

await $`bun install --frozen-lockfile`.cwd(engineDir);
await $`bun run build`.cwd(engineDir);

mkdirSync(binariesDir, { recursive: true });
copyFileSync(join(engineDir, "dist", `winku-engine${exe}`), join(binariesDir, `winku-engine-${triple}${exe}`));
console.log(`Staged winku-engine-${triple}${exe}`);
