// Which shell tools the assistant gets on this machine.
import { win32 } from "node:path";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

export interface ShellChoice {
	powershell: boolean;
	/** Path of the bash to use, when there is one. */
	bash: string | undefined;
}

/** The WSL launcher (System32\bash.exe) runs Linux, not the user's Windows shell; it doesn't count as a bash. */
function isWslLauncher(path: string, systemRoot: string | undefined): boolean {
	const normalized = win32.normalize(path).toLowerCase();
	if (systemRoot) {
		const root = win32.normalize(systemRoot).toLowerCase();
		return ["system32", "sysnative"].some((dir) => normalized === win32.join(root, dir, "bash.exe"));
	}
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

/**
 * PowerShell on Windows; bash whenever one is found (Git Bash or another bash on PATH on Windows,
 * always on Linux and macOS, where pi falls back to sh). `findBash` returns the bash path or throws.
 */
export function chooseShells(platform: NodeJS.Platform, findBash: () => string, systemRoot?: string): ShellChoice {
	if (platform !== "win32") {
		let bash = "/bin/sh";
		try {
			bash = findBash();
		} catch {}
		return { powershell: false, bash };
	}
	let bash: string | undefined;
	try {
		bash = findBash();
	} catch {
		bash = undefined;
	}
	if (bash && isWslLauncher(bash, systemRoot)) bash = undefined;
	return { powershell: true, bash };
}

let cached: ShellChoice | undefined;

/** chooseShells for this machine, looked up once. */
export function localShells(): ShellChoice {
	cached ??= chooseShells(process.platform, () => getShellConfig().shell, process.env.SystemRoot);
	return cached;
}

/** pi's grep runs ripgrep; it is only offered when rg is on PATH. */
export function hasRipgrep(): boolean {
	return !!Bun.which("rg");
}
