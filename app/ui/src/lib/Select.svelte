<script lang="ts" module>
	export type SelectOption<T> = {
		value: T;
		label: string;
		/** A short second line, muted. */
		hint?: string;
		/** Options with the same group follow a heading of that name. */
		group?: string;
	};

	let nextId = 0;
</script>

<script lang="ts" generics="T">
	// A dropdown drawn in Winku's own style, in place of the native <select> (whose popup is the
	// OS's own, light on some systems). Keyboard: arrows, Home/End, Enter or Space to pick,
	// typing jumps to a match, Esc closes without letting the window see it.
	// `inline`: the list opens in the page's flow, pushing what follows down. The bar uses it:
	// its window is only as big as what it draws, so a floating list would be cut off.
	import { tick } from "svelte";

	let {
		value = $bindable(),
		options,
		label,
		onchange,
		inline = false,
		disabled = false,
		class: className = "",
	}: {
		value: T;
		options: SelectOption<T>[];
		/** The accessible name. */
		label: string;
		onchange?: (value: T) => void;
		inline?: boolean;
		disabled?: boolean;
		class?: string;
	} = $props();

	const id = `select-${++nextId}`;
	let open = $state(false);
	let active = $state(-1);
	let above = $state(false);
	let root: HTMLDivElement | undefined = $state();
	let list: HTMLDivElement | undefined = $state();
	let trigger: HTMLButtonElement | undefined = $state();
	let typed = "";
	let typedTimer: ReturnType<typeof setTimeout> | undefined;

	const selectedIndex = $derived(options.findIndex((o) => o.value === value));
	const current = $derived(options[selectedIndex]);

	async function show() {
		if (disabled || open) return;
		active = Math.max(selectedIndex, 0);
		above = false;
		open = true;
		await tick();
		if (!inline && root && list) {
			// Open upwards when the list wouldn't fit below and fits better above.
			const box = root.getBoundingClientRect();
			const below = window.innerHeight - box.bottom;
			above = below < list.offsetHeight + 8 && box.top > below;
		}
		reveal();
	}

	function hide(refocus = true) {
		open = false;
		if (refocus) trigger?.focus();
	}

	function pick(index: number) {
		const option = options[index];
		if (!option) return;
		hide();
		if (option.value === value) return;
		value = option.value;
		onchange?.(option.value);
	}

	function move(to: number) {
		active = Math.min(Math.max(to, 0), options.length - 1);
		reveal();
	}

	function reveal() {
		void tick().then(() => {
			list?.querySelector<HTMLElement>(`#${id}-${active}`)?.scrollIntoView({ block: "nearest" });
		});
	}

	/** Typing jumps to the next option starting with what was typed in the last half second. */
	function seek(char: string) {
		clearTimeout(typedTimer);
		typed += char.toLowerCase();
		typedTimer = setTimeout(() => (typed = ""), 500);
		const from = open ? active : selectedIndex;
		const start = typed.length === 1 ? from + 1 : Math.max(from, 0);
		for (let i = 0; i < options.length; i++) {
			const index = (start + i) % options.length;
			if (options[index].label.toLowerCase().startsWith(typed)) {
				if (open) move(index);
				else pick(index);
				return;
			}
		}
	}

	function onkeydown(event: KeyboardEvent) {
		const { key } = event;
		if (event.ctrlKey || event.altKey || event.metaKey) {
			if (key === "ArrowDown" && event.altKey && !open) {
				event.preventDefault();
				void show();
			}
			return;
		}
		let handled = true;
		if (!open) {
			if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") void show();
			else if (key.length === 1) seek(key);
			else handled = false;
		} else if (key === "ArrowDown") move(active + 1);
		else if (key === "ArrowUp") move(active - 1);
		else if (key === "Home" || key === "PageUp") move(key === "Home" ? 0 : active - 8);
		else if (key === "End" || key === "PageDown") move(key === "End" ? options.length - 1 : active + 8);
		else if (key === "Enter" || key === " ") pick(active);
		else if (key === "Escape") hide();
		else if (key === "Tab") {
			hide(false);
			handled = false;
		} else if (key.length === 1) seek(key);
		else handled = false;
		if (handled) {
			event.preventDefault();
			// Esc here only closes the list: the bar and Settings shouldn't also act on it.
			event.stopPropagation();
		}
	}

	function onfocusout(event: FocusEvent) {
		if (open && !root?.contains(event.relatedTarget as Node | null)) hide(false);
	}

	$effect(() => {
		if (!open) return;
		const away = (event: PointerEvent) => {
			if (!root?.contains(event.target as Node)) hide(false);
		};
		window.addEventListener("pointerdown", away, true);
		return () => window.removeEventListener("pointerdown", away, true);
	});
</script>

<div class="select {className}" class:open class:inline bind:this={root} {onfocusout}>
	<button
		bind:this={trigger}
		type="button"
		class="trigger"
		role="combobox"
		aria-label={label}
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-controls="{id}-list"
		aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
		{disabled}
		onclick={() => (open ? hide() : show())}
		{onkeydown}
	>
		<span class="value">{current?.label ?? (value == null ? "" : String(value))}</span>
		<svg class="chevron" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" /></svg>
	</button>
	{#if open}
		<!-- Focus stays on the button; the list follows it with aria-activedescendant. -->
		<div bind:this={list} id="{id}-list" class="list" class:above role="listbox" aria-label={label} tabindex="-1">
			{#each options as option, i (i)}
				{#if option.group && option.group !== options[i - 1]?.group}
					<div class="group" role="presentation">{option.group}</div>
				{/if}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<div
					id="{id}-{i}"
					class="option"
					class:active={i === active}
					class:selected={i === selectedIndex}
					role="option"
					tabindex="-1"
					aria-selected={i === selectedIndex}
					onpointermove={() => (active = i)}
					onpointerdown={(e) => e.preventDefault()}
					onclick={() => pick(i)}
				>
					<span class="label">{option.label}</span>
					{#if option.hint}<span class="hint">{option.hint}</span>{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.select {
		position: relative;
		min-width: 0;
		width: 100%;
	}
	.trigger {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 32px;
		padding: 0 10px 0 11px;
		border-radius: 8px;
		border: 1px solid var(--line-strong);
		background: var(--field, var(--panel-raised));
		color: var(--text);
		font-size: 13px;
		text-align: left;
		cursor: pointer;
		transition: border-color 120ms ease;
	}
	.trigger:hover:not(:disabled) {
		border-color: rgb(255 255 255 / 0.32);
	}
	.trigger:focus-visible,
	.open .trigger {
		outline: none;
		border-color: var(--focus);
	}
	.trigger:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.value {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chevron {
		flex: none;
		fill: none;
		stroke: var(--muted);
		stroke-width: 1.4;
		stroke-linecap: round;
		stroke-linejoin: round;
		transition: transform 120ms ease;
	}
	.open .chevron {
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
	.group {
		padding: 8px 8px 3px;
		color: var(--faint);
		font-size: 11px;
		font-weight: 600;
	}
	.group:first-child {
		padding-top: 4px;
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
	.label {
		overflow-wrap: anywhere;
	}
	.hint {
		color: var(--muted);
		font-size: 11.5px;
	}
</style>
