// A stand-in for the agent-desktop CLI: just enough of its envelopes to drive the desktop_* tools.
// State (one Notepad-like window) lives in $AGENT_DESKTOP_HOME/fake.json; every call is appended
// to calls.jsonl there with its arguments and stdin.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.AGENT_DESKTOP_HOME ?? ".";
const statePath = join(home, "fake.json");
interface State {
	text: string;
	snapshots: number;
	/** Rows of buttons to add, to make a tree too big for one look. */
	extraButtons: number;
	winkuPid: number;
}
const state: State = existsSync(statePath)
	? JSON.parse(readFileSync(statePath, "utf8"))
	: { text: "", snapshots: 0, extraButtons: 0, winkuPid: 4242 };
const save = () => writeFileSync(statePath, JSON.stringify(state));

const args = process.argv.slice(2);
const stdin = args.includes("--stdin") ? await new Response(Bun.stdin.stream()).text() : undefined;
appendFileSync(join(home, "calls.jsonl"), `${JSON.stringify({ args, stdin })}\n`);

const out = (data: unknown, command = args[0]) => {
	console.log(JSON.stringify({ version: "2.6", ok: true, command, data }));
	process.exit(0);
};
const fail = (code: string, message: string, disposition = { delivery: "not_delivered", retry: "safe" }, details?: unknown) => {
	console.log(JSON.stringify({ version: "2.6", ok: false, command: args[0], error: { code, message, disposition, ...(details ? { details } : {}) } }));
	process.exit(1);
};
const flag = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
/** Positionals: everything after "--". */
const positionals = () => {
	const i = args.indexOf("--");
	return i >= 0 ? args.slice(i + 1) : [];
};

const NOTEPAD = "w-1001";
const WINKU = "w-2002";

function tree(id: string, skeleton: boolean) {
	const children: unknown[] = [
		{ role: "menuitem", name: "File", ref_id: `@${id}:e1` },
		{ role: "textfield", name: "Text editor", ref_id: `@${id}:e2`, value: state.text, states: ["focused", "enabled"] },
		{ role: "button", name: "Save", ref_id: `@${id}:e3` },
	];
	if (state.extraButtons) {
		const group = {
			role: "group",
			name: "Lots",
			ref_id: `@${id}:e4`,
			...(skeleton
				? { children_count: state.extraButtons }
				: {
						children: Array.from({ length: state.extraButtons }, (_, i) => ({
							role: "button",
							name: `Button number ${i} with a long label`,
							ref_id: `@${id}:e${10 + i}`,
						})),
					}),
		};
		children.push(group);
	}
	return { role: "window", name: "Untitled - Notepad", children };
}

const KNOWN_REF = /^@(s\d+):e(\d+)$/;
function checkRef(ref: string | undefined) {
	const match = KNOWN_REF.exec(ref ?? "");
	if (!match) fail("INVALID_ARGS", `Invalid ref_id '${ref}'`);
	if (Number(match?.[1]?.slice(1)) < state.snapshots - 1)
		fail("STALE_REF", "The element no longer matches", { delivery: "not_delivered", retry: "safe" }, { kind: "saved_ref_absent" });
	if (match?.[2] === "99") fail("ACTION_FAILED", "Maybe clicked", { delivery: "delivered_unverified", retry: "unsafe" });
}

switch (args[0]) {
	case "list-windows":
		out([
			{ id: NOTEPAD, title: "Untitled - Notepad", app_name: "notepad", pid: 77, is_focused: false, accessible: true },
			{ id: WINKU, title: "Winku", app_name: "winku", pid: state.winkuPid, is_focused: true, accessible: true },
			{ id: "w-3003", title: "Settings", app_name: "something", pid: state.winkuPid, accessible: true },
		]);
		break;
	case "snapshot": {
		const root = flag("--root");
		const windowId = flag("--window-id");
		if (!root && windowId !== NOTEPAD) fail("WINDOW_NOT_FOUND", `Window '${windowId}' was not found`);
		if (root) checkRef(root);
		state.snapshots++;
		const id = root ? (KNOWN_REF.exec(root)?.[1] ?? "s0") : `s${state.snapshots}`;
		save();
		const skeleton = args.includes("--skeleton");
		const t = tree(id, skeleton);
		out({
			app: "notepad",
			window: { id: NOTEPAD, title: "Untitled - Notepad" },
			snapshot_id: id,
			ref_count: 3,
			complete: true,
			tree: root ? t.children[3] : t,
		});
		break;
	}
	case "set-value":
	case "type": {
		const [ref] = positionals();
		checkRef(ref);
		state.text = args[0] === "type" ? state.text + (stdin ?? "") : (stdin ?? "");
		save();
		out({ action: args[0], disposition: { delivery: "delivered_verified", retry: "unsafe" }, post_state: { value: state.text } });
		break;
	}
	case "click": {
		const [ref] = positionals();
		checkRef(ref);
		out({ action: "click", disposition: { delivery: "delivered_unverified", retry: "unsafe" } });
		break;
	}
	case "press":
		out({ action: "press", disposition: { delivery: "delivered_unverified", retry: "unsafe" } });
		break;
	case "launch":
		out({ app: positionals()[0], pid: 88, window: { id: "w-5005", title: "Untitled - Notepad", visible: true } });
		break;
	case "focus-window":
		out({ action: "focus_window", disposition: { delivery: "delivered_verified", retry: "unsafe" } });
		break;
	case "slow":
		await new Promise((resolve) => setTimeout(resolve, 60_000));
		out({});
		break;
	case "garbage":
		console.log("not json");
		process.exit(3);
		break;
	default:
		fail("INVALID_ARGS", `unknown command ${args[0]}`);
}
