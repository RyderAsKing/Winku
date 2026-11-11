<script lang="ts">
	import { bindingFromEvent } from "./hotkey.ts";

	let { value, onchange, conflict = false, label }: { value: string; onchange: (v: string) => void; conflict?: boolean; label: string } =
		$props();
	let capturing = $state(false);

	function onkeydown(event: KeyboardEvent) {
		if (!capturing) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.key === "Escape" && !event.ctrlKey && !event.altKey) {
			capturing = false;
			return;
		}
		const binding = bindingFromEvent(event);
		if (binding) {
			capturing = false;
			onchange(binding);
		}
	}
</script>

<button
	type="button"
	class="hotkey mono"
	class:capturing
	class:conflict
	aria-label="{label}: {value}. Click to change"
	onclick={() => (capturing = !capturing)}
	onblur={() => (capturing = false)}
	{onkeydown}
>
	{capturing ? "Press keys…" : value}
</button>

<style>
	.hotkey {
		min-width: 140px;
		height: 30px;
		padding: 0 12px;
		border-radius: 8px;
		border: 1px solid var(--line-strong);
		background: var(--panel-raised);
		font-size: 12px;
		cursor: pointer;
		text-align: center;
	}
	.capturing {
		border-color: var(--focus);
		color: var(--accent);
	}
	.conflict {
		border-color: var(--error);
	}
</style>
