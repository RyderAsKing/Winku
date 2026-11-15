// Local images in visuals (SPEC §3 Visuals): an <img> whose src is an absolute local path is
// written into the page as a data URL before the page is saved, so the sandboxed frame never
// reads the disk. Each file is checked by its bytes, so only real images go in. Remote images
// and scripts are left as written (ADR 0001).
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/** Largest single local image written into a page. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** Largest total of local image bytes written into one page. */
export const MAX_INLINE_IMAGE_BYTES = 6 * 1024 * 1024;

const SMALLER = "Use smaller images (resize or compress them first) or fewer of them.";

/** The image type the bytes start with, or undefined if they aren't an image we take. */
export function sniffImage(bytes: Buffer): string | undefined {
	const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
	if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
	if (bytes.subarray(0, 6).toString("latin1").match(/^GIF8[79]a$/)) return "image/gif";
	if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
	if (starts(0x42, 0x4d) && bytes.length > 14) return "image/bmp";
	if (starts(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
	if (bytes.subarray(4, 12).toString("latin1").match(/^ftypavi[fs]$/)) return "image/avif";
	const head = bytes.subarray(0, 1024).toString("utf8").replace(/^﻿/, "").trimStart();
	if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
	return undefined;
}

/** The local file an image src names, or undefined if it isn't a local absolute path. */
function localPath(src: string): string | undefined {
	if (/^file:\/\//i.test(src)) return fileURLToPath(src);
	if (src.startsWith("//")) return undefined; // protocol-relative, i.e. remote
	if (/^[a-z]:[\\/]/i.test(src) || src.startsWith("\\\\")) return src; // Windows drive or UNC path
	if (src.startsWith("/") && isAbsolute(src)) return src;
	return undefined;
}

/** Writes each local image the page names into it as data; throws a message for the model if one can't go in. */
export function inlineLocalImages(html: string): string {
	let total = 0;
	const cache = new Map<string, string>();
	return html.replace(/<img\b[^>]*>/gi, (tag) =>
		tag.replace(/(\ssrc\s*=\s*)(["'])(.*?)\2/i, (whole, pre: string, quote: string, src: string) => {
			const path = localPath(src.trim());
			if (!path) return whole;
			let data = cache.get(path);
			if (!data) {
				let size: number;
				try {
					size = statSync(path).size;
				} catch {
					throw new Error(`Couldn't read the image ${path}: no such file.`);
				}
				if (size > MAX_IMAGE_BYTES)
					throw new Error(`The image ${path} is ${mb(size)}, over the ${mb(MAX_IMAGE_BYTES)} limit for one image. ${SMALLER}`);
				total += size;
				if (total > MAX_INLINE_IMAGE_BYTES)
					throw new Error(`The local images in this page add up to more than the ${mb(MAX_INLINE_IMAGE_BYTES)} limit for a page. ${SMALLER}`);
				const bytes = readFileSync(path);
				const type = sniffImage(bytes);
				if (!type) throw new Error(`${path} is not an image (checked by its contents, not its name), so it wasn't put in the page.`);
				data = `data:${type};base64,${bytes.toString("base64")}`;
				cache.set(path, data);
			}
			return `${pre}${quote}${data}${quote}`;
		}),
	);
}

function mb(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
