// Model output → sanitised HTML. Model text is untrusted: everything goes through DOMPurify,
// links open externally (handled by the caller), and no raw HTML from the model survives.
import DOMPurify from "dompurify";
import { Marked } from "marked";

const marked = new Marked({ gfm: true, breaks: false, async: false });

export function renderMarkdown(text: string): string {
	const html = marked.parse(text) as string;
	return DOMPurify.sanitize(html, {
		USE_PROFILES: { html: true },
		FORBID_TAGS: ["style", "img", "iframe", "form", "input", "button"],
		FORBID_ATTR: ["style"],
	});
}
