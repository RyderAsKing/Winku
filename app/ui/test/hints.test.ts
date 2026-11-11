import { expect, test } from "bun:test";
import { defaultSettings } from "../src/lib/defaults.ts";
import { afterPrefix, hintsFor } from "../src/main/hints.ts";

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
