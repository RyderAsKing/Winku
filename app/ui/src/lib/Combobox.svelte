<script lang="ts" module>
	export type ComboOption = {
		value: string;
		label: string;
		/** A short second line, muted. */
		hint?: string;
	};

	let nextId = 0;

	/** The options matching every word of `query`, in their own order. */
	export function matching(options: ComboOption[], query: string): ComboOption[] {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (words.length === 0) return options;
		return options.filter((o) => {
			const text = `${o.value} ${o.label}`.toLowerCase();
			return words.every((w) => text.includes(w));
		});
	}
</script>

<script lang="ts">
	// A text field with a list to pick from, for model ids: the list is a suggestion, and any id
	// typed in is kept as it is. Replaces <datalist>, which only lists entries matching what is
	// already in the field (so a filled-in field hides all the others) and can't be styled.
	// Clicking the field or pressing Down shows everything; typing narrows the list.
	// `inline`: the list opens in the page's flow (see Select.svelte).
	import { tick } from "svelte";

	let {
		value = $bindable(),
		options,
		label,
		placeholder = "",
		inline = false,
		oninput,
	}: {
		value: string;
		options: ComboOption[];
		/** The accessible name. */
		label: string;
		placeholder?: string;
		inline?: boolean;
		oninput?: (value: string) => void;
	} = $props();

	const id = `combo-${++nextId}`;
	let open = $state(false);
	/** Narrow the list to what's typed; off when the list was opened to browse. */
	let filtering = $state(false);
	let active = $state(-1);
	let above = $state(false);
	let root: HTMLDivElement | undefined = $state();
	let list: HTMLDivElement | undefined = $state();
	let input: HTMLInputElement | undefined = $state();

	const shown = $derived(filtering ? matching(options, value) : options);

	async function show(browse: boolean) {
		if (options.length === 0) return;
		filtering = !browse;
		active = shown.findIndex((o) => o.value === value.trim());
		if (open) return reveal();
		above = false;
		open = true;
		await tick();
		if (!inline && root && list) {
			const box = root.getBoundingClientRect();
			const below = window.innerHeight - box.bottom;
			above = below < list.offsetHeight + 8 && box.top > below;
		}
		reveal();
	}

	function hide() {
		open = false;
		filtering = false;
	}

	function pick(option: ComboOption) {
		value = option.value;
		oninput?.(option.value);
		hide();
		input?.focus();
	}

	function move(by: number) {
		if (!open) return void show(true);
		if (shown.length === 0) return;
		active = active < 0 ? (by > 0 ? 0 : shown.length - 1) : Math.min(Math.max(active + by, 0), shown.length - 1);
		reveal();
	}

	function reveal() {
		void tick().then(() => {
			list?.querySelector<HTMLElement>(`#${id}-${active}`)?.scrollIntoView({ block: "nearest" });
		});
	}

	function onkeydown(event: KeyboardEvent) {
		let handled = true;
		if (event.key === "ArrowDown") move(1);
		else if (event.key === "ArrowUp") move(-1);
		else if (event.key === "PageDown") move(8);
		else if (event.key === "PageUp") move(-8);
		else if (event.key === "Enter" && open && shown[active]) pick(shown[active]);
		else if (event.key === "Escape" && open) hide();
		else {
			if (event.key === "Tab" || event.key === "Enter") hide();
			handled = false;
		}
		if (handled) {
			event.preventDefault();
			// Esc here only closes the list: the bar and Settings shouldn't also act on it.
			event.stopPropagation();
		}
	}

	function onInput() {
		oninput?.(value);
		if (options.length === 0) return;
		filtering = true;
		active = -1;
		if (!open) void show(false);
	}

	function onfocusout(event: FocusEvent) {
		if (open && !root?.contains(event.relatedTarget as Node | null)) hide();
	}

	$effect(() => {
		if (!open) return;
		const away = (event: PointerEvent) => {
			if (!root?.contains(event.target as Node)) hide();
		};
		window.addEventListener("pointerdown", away, true);
		return () => window.removeEventListener("pointerdown", away, true);
	});
</script>

<div class="combo" class:open class:inline class:listed={options.length > 0} bind:this={root} {onfocusout}>
	<div class="field">
		<input
			bind:this={input}
			bind:value
			role="combobox"
			aria-label={label}
			aria-autocomplete="list"
			aria-expanded={open}
			aria-controls="{id}-list"
			aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
			autocomplete="off"
			spellcheck="false"
			{placeholder}
			oninput={onInput}
			onclick={() => !open && show(true)}
			{onkeydown}
		/>
		{#if options.length > 0}
			<button
				type="button"
				class="toggle"
				tabindex="-1"
				aria-label="Show {label.toLowerCase()} list"
				onpointerdown={(e) => e.preventDefault()}
				onclick={() => {
					input?.focus();
					if (open) hide();
					else void show(true);
				}}
			>
				<svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" /></svg>
			</button>
		{/if}
	</div>
	{#if open}
		<div bind:this={list} id="{id}-list" class="list" class:above role="listbox" aria-label={label} tabindex="-1">
			{#each shown as option, i (i)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<div
					id="{id}-{i}"
					class="option"
					class:active={i === active}
					class:selected={option.value === value.trim()}
					role="option"
					tabindex="-1"
					aria-selected={option.value === value.trim()}
					onpointermove={() => (active = i)}
					onpointerdown={(e) => e.preventDefault()}
					onclick={() => pick(option)}
				>
					<span class="label">{option.label}</span>
					{#if option.hint}<span class="hint">{option.hint}</span>{/if}
				</div>
			{:else}
				<p class="none">No listed model matches. Winku will use <span class="mono">{value.trim()}</span> as typed.</p>
			{/each}
		</div>
	{/if}
</div>

<style>
	.combo {
		position: relative;
		min-width: 0;
		width: 100%;
	}
	.field {
		position: relative;
	}
	input {
		width: 100%;
		min-width: 0;
		height: 32px;
		padding: 0 10px 0 11px;
		border-radius: 8px;
		border: 1px solid var(--line-strong);
		background: var(--panel-raised);
		outline: none;
		font-size: 13px;
		transition: border-color 120ms ease;
	}
	.listed input {
		padding-right: 32px;
	}
	input:hover {
		border-color: rgb(255 255 255 / 0.32);
	}
	input:focus,
	input:focus-visible {
		outline: none;
		border-color: var(--focus);
	}
	input::placeholder {
		color: var(--faint);
	}
	.toggle {
		position: absolute;
		top: 1px;
		right: 1px;
		bottom: 1px;
		width: 30px;
		display: grid;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: 0 7px 7px 0;
		background: none;
		cursor: pointer;
	}
	.toggle svg {
		fill: none;
		stroke: var(--muted);
		stroke-width: 1.4;
		stroke-linecap: round;
		stroke-linejoin: round;
		transition: transform 120ms ease;
	}
	.open .toggle svg {
		transform: rotate(180deg);
	}
	.list {
		position: absolute;
		z-index: 20;
		top: calc(100% + 4px);
		right: 0;
		/* At least as wide as the field, and wider for long entries, growing to the left: fields
		   sit at the right of Settings rows. */
		min-width: 100%;
		width: max-content;
		max-width: min(420px, calc(100vw - 32px));
		max-height: 264px;
		overflow-y: auto;
		padding: 4px;
		border-radius: 10px;
		border: 1px solid var(--line-strong);
		background: #1a1d26;
		box-shadow: 0 10px 28px rgb(0 0 0 / 0.45);
		outline: none;
		overscroll-behavior: contain;
	}
	.list.above {
		top: auto;
		bottom: calc(100% + 4px);
	}
	.inline .list {
		position: static;
		width: auto;
		max-width: none;
		margin-top: 4px;
		max-height: 184px;
		box-shadow: none;
	}
	.option {
		display: flex;
		flex-direction: column;
		justify-content: center;
		min-height: 30px;
		padding: 4px 8px;
		border-radius: 6px;
		font-size: 13px;
		line-height: 1.35;
		cursor: pointer;
	}
	.option.active {
		background: rgb(255 255 255 / 0.07);
	}
	.option.selected .label {
		color: var(--accent);
	}
	.label,
	.hint {
		overflow-wrap: anywhere;
	}
	.hint {
		color: var(--muted);
		font-size: 11.5px;
	}
	.none {
		margin: 0;
		padding: 6px 8px;
		color: var(--muted);
		font-size: 12px;
		text-wrap: pretty;
	}
	.mono {
		font-family: var(--mono);
		color: var(--text);
		overflow-wrap: anywhere;
	}
</style>
