// pi's find tool runs fd, which the engine never downloads (PI_OFFLINE). This glob backend
// needs nothing installed. Patterns without a "/" match at any depth, like fd's.
import { existsSync } from "node:fs";
import type { FindOperations } from "@earendil-works/pi-coding-agent";

const SKIP = /(^|[\\/])(node_modules|\.git)([\\/]|$)/;

export const globFindOperations: FindOperations = {
	exists: (path) => existsSync(path),
	glob: (pattern, cwd, { limit }) => {
		const glob = new Bun.Glob(pattern.includes("/") || pattern.startsWith("**") ? pattern : `**/${pattern}`);
		const results: string[] = [];
		for (const path of glob.scanSync({ cwd, dot: true, onlyFiles: false, followSymlinks: false, throwErrorOnBrokenSymlink: false })) {
			if (SKIP.test(path)) continue;
			results.push(path);
			if (results.length >= limit) break;
		}
		return results;
	},
};
