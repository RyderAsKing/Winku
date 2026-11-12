import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const root = resolve(import.meta.dirname, "ui");

export default defineConfig({
	root,
	plugins: [svelte()],
	clearScreen: false,
	server: { port: 5173, strictPort: true, host: "0.0.0.0" },
	build: {
		outDir: resolve(root, "dist"),
		emptyOutDir: true,
		target: "es2022",
		rollupOptions: {
			input: {
				main: resolve(root, "index.html"),
				settings: resolve(root, "settings.html"),
				history: resolve(root, "history.html"),
				guide: resolve(root, "guide.html"),
			},
		},
	},
});
