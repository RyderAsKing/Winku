// Stages the agent-desktop CLI (vercel-labs/agent-desktop, Apache-2.0) as a Tauri sidecar:
// src-tauri/binaries/agent-desktop-<rust target triple>[.exe]. The engine's desktop_* tools
// (computer use) run it. The release archive is pinned by version and SHA-256 and checked
// before anything is unpacked; nothing is downloaded at runtime.
//
// To upgrade: change VERSION, copy the new hashes from the release's checksums.txt, update
// docs/ARCHITECTURE.md "Computer use" and app/src-tauri/licenses/ if the licence changed.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export const VERSION = "1.2.0";

/** CLI archives of the release, by Rust target triple. From the release's checksums.txt. */
export const ARCHIVES: Record<string, { file: string; sha256: string }> = {
	"x86_64-pc-windows-msvc": {
		file: `agent-desktop-v${VERSION}-x86_64-pc-windows-msvc.tar.gz`,
		sha256: "a4199f741a441cedd349bf56c5eba01783b1261258b498efeb7ec9945220c3e8",
	},
	"aarch64-pc-windows-msvc": {
		file: `agent-desktop-v${VERSION}-aarch64-pc-windows-msvc.tar.gz`,
		sha256: "d6d8643310c2c13eace2261444d9e4c0d16ca09581f38500983104903604caa6",
	},
	"x86_64-unknown-linux-gnu": {
		file: `agent-desktop-v${VERSION}-x86_64-unknown-linux-gnu.tar.gz`,
		sha256: "591ae7f4a38479dc045df97e27447c0c8b530441730ab6b990e27c813162af44",
	},
	"aarch64-unknown-linux-gnu": {
		file: `agent-desktop-v${VERSION}-aarch64-unknown-linux-gnu.tar.gz`,
		sha256: "68e8ebbb4f80e44485d2f1cf972943a38ee43108e2e0ce56bdfa641fd1599f68",
	},
	"x86_64-apple-darwin": {
		file: `agent-desktop-v${VERSION}-x86_64-apple-darwin.tar.gz`,
		sha256: "d9dc50226f28d7fc86a2f5b0945f0c206dff6c31e418907749f493b6f9e773e6",
	},
	"aarch64-apple-darwin": {
		file: `agent-desktop-v${VERSION}-aarch64-apple-darwin.tar.gz`,
		sha256: "219813428bb1ad8decae172faed05c5964a2415170df402e2786ccfa6452ba82",
	},
};

const RELEASE_URL = `https://github.com/vercel-labs/agent-desktop/releases/download/v${VERSION}`;
const appDir = join(import.meta.dir, "..");
const cacheDir = join(appDir, ".cache", "agent-desktop");
const binariesDir = join(appDir, "src-tauri", "binaries");

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** One regular file from a tar archive, by base name. */
export function untarOne(tar: Uint8Array, baseName: string): Uint8Array | undefined {
	const text = (start: number, length: number) => {
		const field = tar.subarray(start, start + length);
		const end = field.indexOf(0);
		return new TextDecoder().decode(end >= 0 ? field.subarray(0, end) : field);
	};
	let offset = 0;
	while (offset + 512 <= tar.length) {
		const name = text(offset, 100);
		if (!name) break;
		const prefix = text(offset + 345, 155);
		const size = Number.parseInt(text(offset + 124, 12).trim() || "0", 8);
		const type = text(offset + 156, 1) || "0";
		const path = prefix ? `${prefix}/${name}` : name;
		const body = offset + 512;
		if ((type === "0" || type === "") && path.split("/").pop() === baseName) return tar.slice(body, body + size);
		offset = body + Math.ceil(size / 512) * 512;
	}
	return undefined;
}

async function archive(file: string, expected: string): Promise<Uint8Array> {
	const cached = join(cacheDir, file);
	if (existsSync(cached)) {
		const bytes = new Uint8Array(readFileSync(cached));
		if (sha256(bytes) === expected) return bytes;
	}
	const response = await fetch(`${RELEASE_URL}/${file}`);
	if (!response.ok) throw new Error(`Downloading ${file} failed: HTTP ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	const actual = sha256(bytes);
	if (actual !== expected) throw new Error(`${file}: SHA-256 is ${actual}, expected ${expected}. Refusing to bundle it.`);
	mkdirSync(cacheDir, { recursive: true });
	writeFileSync(`${cached}.tmp`, bytes);
	renameSync(`${cached}.tmp`, cached);
	return bytes;
}

/** Verifies and stages the CLI for `triple`. */
export async function stageAgentDesktop(triple: string): Promise<string> {
	const pinned = ARCHIVES[triple];
	if (!pinned) throw new Error(`No pinned agent-desktop ${VERSION} build for ${triple}`);
	const windows = triple.includes("windows");
	const exeName = windows ? "agent-desktop.exe" : "agent-desktop";
	const exe = untarOne(gunzipSync(await archive(pinned.file, pinned.sha256)), exeName);
	if (!exe) throw new Error(`${pinned.file} has no ${exeName}`);
	mkdirSync(binariesDir, { recursive: true });
	const target = join(binariesDir, `agent-desktop-${triple}${windows ? ".exe" : ""}`);
	writeFileSync(target, exe);
	if (!windows) chmodSync(target, 0o755);
	return target;
}

if (import.meta.main) {
	const triple = process.argv[2] ?? (await Bun.$`rustc --print host-tuple`.text()).trim();
	const target = await stageAgentDesktop(triple);
	console.log(`Staged agent-desktop ${VERSION} (SHA-256 checked) at ${target}`);
}
