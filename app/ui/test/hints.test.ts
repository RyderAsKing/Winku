import { expect, test } from "bun:test";
import { defaultSettings } from "../src/lib/defaults.ts";
import { afterPrefix, hintsFor, selectionState } from "../src/main/hints.ts";

test("the key after Ctrl+Alt, in any case; other bindings have none", () => {
	expect(afterPrefix("Ctrl+Alt+Space")).toBe("Space");
	expect(afterPrefix("ctrl+alt+q")).toBe("q");
	expect(afterPrefix("Ctrl+Shift+Q")).toBeNull();
	expect(afterPrefix("Ctrl+Alt+Shift+Q")).toBeNull();
	expect(afterPrefix("")).toBeNull();
});

test("the default keys: five actions by name, then the rest", () => {
	const { actions, other } = hintsFor(defaultSettings());
	expect(actions.map((h) => h.key)).toEqual(["1", "2", "3", "4", "5"]);
	expect(actions[0]?.label).toBe(defaultSettings().actions[0]?.name);
	expect(other.map((h) => h.key)).toEqual(["Space", "Q", "S", "X", "T"]);
});

test("a rebound or nameless key is left out", () => {
	const s = defaultSettings();
	s.hotkeys.askSelection = "Ctrl+Shift+Q";
	s.actions[1] = { ...s.actions[1]!, name: " " };
	const { actions, other } = hintsFor(s);
	expect(actions.map((h) => h.key)).toEqual(["1", "3", "4", "5"]);
	expect(other.some((h) => h.label === "Ask about the selection")).toBe(false);
});

const keys = (lists: { actions: { key: string }[]; other: { key: string }[] }) => ({
	actions: lists.actions.map((h) => h.key),
	other: lists.other.map((h) => h.key),
});

test("unknown selection: everything, as before", () => {
	expect(keys(hintsFor(defaultSettings(), "unknown"))).toEqual({
		actions: ["1", "2", "3", "4", "5"],
		other: ["Space", "Q", "S", "X", "T"],
	});
});

test("nothing selected: only the general keys", () => {
	expect(keys(hintsFor(defaultSettings(), "none"))).toEqual({
		actions: [],
		other: ["Space", "S", "X", "T"],
	});
});

test("editable selection: the actions and Ask about the selection", () => {
	const lists = hintsFor(defaultSettings(), "editable");
	expect(keys(lists)).toEqual({ actions: ["1", "2", "3", "4", "5"], other: ["Q"] });
	expect(lists.other[0]?.label).toBe("Ask about the selection");
});

test("read-only selection: replace actions are left out", () => {
	const s = defaultSettings();
	s.actions = s.actions.map((a, i) => ({ ...a, output: i < 2 ? "replace" : i === 2 ? "show" : "agent" }));
	expect(keys(hintsFor(s, "read-only"))).toEqual({ actions: ["3", "4", "5"], other: ["Q"] });
});

test("an empty result falls back to the full list", () => {
	const s = defaultSettings();
	s.actions = s.actions.map((a) => ({ ...a, output: "replace" }));
	s.hotkeys.askSelection = "";
	expect(keys(hintsFor(s, "read-only"))).toEqual(keys(hintsFor(s, "unknown")));
	const t = defaultSettings();
	t.hotkeys.summon = t.hotkeys.screenshot = t.hotkeys.clear = t.hotkeys.cycleThinking = "";
	t.hotkeys.askSelection = "";
	expect(keys(hintsFor(t, "none")).actions).toEqual(["1", "2", "3", "4", "5"]);
});

test("the hint event's selection field gives the state", () => {
	expect(selectionState(undefined)).toBe("unknown");
	expect(selectionState(null)).toBe("none");
	expect(selectionState({ editable: true })).toBe("editable");
	expect(selectionState({ editable: false })).toBe("read-only");
});
