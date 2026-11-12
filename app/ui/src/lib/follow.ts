// Keeps a scroll box on its newest content: while it is scrolled to the very bottom, it stays
// there as the content grows (a reply streaming, a message added, an image loading). Scrolling
// up stops that; scrolling back to the bottom starts it again.

/** How close to the bottom counts as at the bottom, px. */
const SLACK = 4;

export function follow(node: HTMLElement, enabled = true) {
	if (!enabled) return {};
	let pinned = true;

	const atBottom = () => node.scrollHeight - node.scrollTop - node.clientHeight <= SLACK;

	const stick = () => {
		// Content that fits needs no scrolling, so the next growth is followed again.
		if (node.scrollHeight <= node.clientHeight) pinned = true;
		if (pinned) node.scrollTop = node.scrollHeight;
	};

	const onscroll = () => {
		pinned = atBottom();
	};

	// A wheel turn upward stops following at once, before a smooth scroll reports its first step.
	const onwheel = (event: WheelEvent) => {
		if (event.deltaY < 0) pinned = false;
	};

	const sizes = new ResizeObserver(stick);
	const observeChildren = () => {
		for (const child of node.children) sizes.observe(child);
	};
	const changes = new MutationObserver(() => {
		observeChildren();
		stick();
	});

	sizes.observe(node);
	observeChildren();
	changes.observe(node, { childList: true, subtree: true, characterData: true });
	node.addEventListener("scroll", onscroll, { passive: true });
	node.addEventListener("wheel", onwheel, { passive: true });
	stick();

	return {
		destroy() {
			sizes.disconnect();
			changes.disconnect();
			node.removeEventListener("scroll", onscroll);
			node.removeEventListener("wheel", onwheel);
		},
	};
}
