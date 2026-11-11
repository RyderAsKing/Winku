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

	// Copy buttons on code blocks; re-applied whenever the rendered HTML changes.
	$effect(() => {
		void html;
		if (!root) return;
		for (const pre of root.querySelectorAll("pre")) {
			if (pre.querySelector(".copy")) continue;
			const button = document.createElement("button");
			button.className = "copy";
			button.type = "button";
			button.textContent = "Copy";
			button.addEventListener("click", async () => {
				await navigator.clipboard.writeText(pre.querySelector("code")?.textContent ?? "");
				button.textContent = "Copied";
				setTimeout(() => (button.textContent = "Copy"), 1200);
			});
			pre.append(button);
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
	.md :global(pre .copy) {
		position: sticky;
		order: -1;
		align-self: flex-end;
		margin-bottom: 8px;
		right: 0;
		padding: 2px 8px;
		font-size: 11px;
		border-radius: 6px;
		border: 1px solid var(--line-strong);
		background: var(--panel-raised);
		color: var(--muted);
		opacity: 1;
		cursor: pointer;
		transition: opacity 120ms ease;
	}
	.md :global(pre:hover .copy),
	.md :global(pre .copy:focus-visible) {
		opacity: 1;
	}
</style>
