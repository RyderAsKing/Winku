// Imported first by main.ts, before any pi module loads.
// Keeps the engine away from pi.dev and keeps stdout for protocol records only.

process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.PI_SKIP_VERSION_CHECK = "1";

// Anything pi or a dependency logs must not corrupt the JSON-lines stream on stdout.
const toStderr = (...args: unknown[]) => {
	process.stderr.write(`${args.map((a) => (typeof a === "string" ? a : Bun.inspect(a))).join(" ")}\n`);
};
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
console.warn = toStderr;
