<script lang="ts">
	// An on/off switch for settings that apply at once.
	let { checked, onchange, label }: { checked: boolean; onchange: (value: boolean) => void; label: string } = $props();
</script>

<button type="button" role="switch" class="switch" aria-checked={checked} aria-label={label} onclick={() => onchange(!checked)}>
	<span class="knob"></span>
</button>

<style>
	.switch {
		flex: none;
		position: relative;
		width: 38px;
		height: 22px;
		padding: 0;
		border-radius: 999px;
		border: 1px solid var(--line-strong);
		background: var(--panel-raised);
		cursor: pointer;
		transition:
			background-color 160ms ease,
			border-color 160ms ease;
	}
	.knob {
		position: absolute;
		top: 3px;
		left: 3px;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--muted);
		transition:
			translate 180ms cubic-bezier(0.22, 1, 0.36, 1),
			background-color 160ms ease;
	}
	.switch[aria-checked="true"] {
		border-color: transparent;
		background: var(--accent);
	}
	.switch[aria-checked="true"] .knob {
		translate: 16px 0;
		background: #041314;
	}
</style>
