// Adds a command and no provider, so Winku turns it away.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("hello", { description: "Says hello", handler: async () => {} });
}
