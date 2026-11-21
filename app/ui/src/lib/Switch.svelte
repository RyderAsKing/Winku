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
		width: 36px;
		height: 20px;
		padding: 0;
		border-radius: 999px;
		border: 0;
		background: rgb(255 255 255 / 0.14);
		cursor: pointer;
		transition: background-color 160ms ease;
	}
	.switch:hover {
		background: rgb(255 255 255 / 0.2);
	}
	.knob {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: #e7e9ee;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.35);
		transition: translate 180ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.switch[aria-checked="true"] {
		background: var(--accent);
	}
	.switch[aria-checked="true"] .knob {
		translate: 16px 0;
		background: #041314;
		box-shadow: none;
	}
</style>
