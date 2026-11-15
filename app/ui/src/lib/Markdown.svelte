<script lang="ts">
	import { untrack } from "svelte";
	import { renderMarkdown } from "./markdown.ts";
	import { shell } from "./shell.ts";

	let { text }: { text: string } = $props();

	// A streamed reply changes many times a frame; render it at most once per frame.
	let shown = $state(untrack(() => text));
	let frame = 0;
	$effect(() => {
		void text;
		if (!frame) {
			frame = requestAnimationFrame(() => {
				frame = 0;
				shown = text;
			});
		}
	});
	$effect(() => () => cancelAnimationFrame(frame));

	const html = $derived(renderMarkdown(shown));
	let root: HTMLElement | undefined = $state();

	// A header on each code block: its language, and a copy button. Re-applied whenever the
	// rendered HTML changes.
	$effect(() => {
		void html;
		if (!root) return;
		for (const pre of root.querySelectorAll("pre")) {
			if (pre.querySelector(".copy")) continue;
			const head = document.createElement("div");
			head.className = "code-head";
			const lang = document.createElement("span");
			lang.className = "lang";
			lang.textContent = /language-([\w+#-]+)/.exec(pre.querySelector("code")?.className ?? "")?.[1] ?? "";
			const button = document.createElement("button");
			button.className = "copy";
			button.type = "button";
			button.textContent = "Copy";
			button.addEventListener("click", async () => {
				await navigator.clipboard.writeText(pre.querySelector("code")?.textContent ?? "");
				button.textContent = "Copied";
				setTimeout(() => (button.textContent = "Copy"), 1200);
			});
			head.append(lang, button);
			pre.prepend(head);
		}
	});

	function onclick(event: MouseEvent) {
		const link = (event.target as HTMLElement).closest("a");
		if (!link) return;
		event.preventDefault();
		const href = link.getAttribute("href");
		if (href && /^https?:\/\//i.test(href)) void shell.openExternal(href);
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="md" bind:this={root} {onclick}>{@html html}</div>

<style>
	/* Sticky, so it stays put while a long line scrolls sideways. */
	.md :global(pre .code-head) {
		position: sticky;
		left: 0;
		align-self: stretch;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 4px;
	}
	.md :global(pre .lang) {
		font-family: var(--mono);
		font-size: 11px;
		color: var(--faint);
	}
	.md :global(pre .copy) {
		padding: 2px 8px;
		font-size: 11px;
		border-radius: 6px;
		border: 0;
		background: rgb(255 255 255 / 0.07);
		color: var(--muted);
		cursor: pointer;
	}
</style>
