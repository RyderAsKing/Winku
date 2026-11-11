<script lang="ts">
	import { renderMarkdown } from "./markdown.ts";
	import { shell } from "./shell.ts";

	let { text }: { text: string } = $props();
	const html = $derived(renderMarkdown(text));
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
		position: absolute;
		top: 6px;
		right: 6px;
		padding: 2px 8px;
		font-size: 11px;
		border-radius: 6px;
		border: 1px solid var(--line-strong);
		background: var(--panel-raised);
		color: var(--muted);
		opacity: 0;
		cursor: pointer;
		transition: opacity 120ms ease;
	}
	.md :global(pre:hover .copy),
	.md :global(pre .copy:focus-visible) {
		opacity: 1;
	}
</style>
