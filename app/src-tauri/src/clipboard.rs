//! The clipboard tools (docs/ARCHITECTURE.md, "Agent tools"): `clipboard_read` and
//! `clipboard_write` Requests, and the clipboard note on the now line. Reads by index and the
//! list come from the clipboard history (clipboard_history.rs).
//!
//! The OS work is in `platform`; this module holds the pure parts: decoding the formats the
//! platform hands over (CF_DIB images, CF_HDROP file lists), the Response data and the note.

use std::time::Instant;

use serde::Serialize;
use serde_json::{json, Value};

use crate::capture::{to_attachment, ImageAttachment};
use crate::platform::{self, RawImage};

/// What the platform found on the clipboard, before images are encoded.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Debug, PartialEq)]
pub enum Raw {
    Empty,
    /// Marked private by a password manager (formats that exclude it from history).
    Private,
    Text(String),
    /// A CF_DIB (BITMAPINFOHEADER and pixels).
    Dib(Vec<u8>),
    Files(Vec<String>),
}

/// What kind of thing is on the clipboard and how big, read without its contents.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Summary {
    Private,
    /// Characters of text (from the size of the clipboard's text, not the text).
    Text(usize),
    Image(u32, u32),
    Files(usize),
}

/// `ClipboardContent` in engine/src/protocol.ts.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Content {
    Empty,
    Private,
    Text {
        text: String,
    },
    Image {
        #[serde(skip_serializing_if = "Option::is_none")]
        image: Option<ImageAttachment>,
        width: u32,
        height: u32,
    },
    Files {
        paths: Vec<String>,
    },
}

/// The now line's clipboard note: "text, 640 characters". None when the clipboard is empty.
pub fn note(summary: Option<Summary>) -> Option<String> {
    let plural =
        |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    Some(match summary? {
        Summary::Private => "private".into(),
        Summary::Text(chars) => format!("text, {}", plural(chars, "character", "characters")),
        Summary::Image(w, h) => format!("image, {w}×{h}"),
        Summary::Files(n) => format!("files, {}", plural(n, "file", "files")),
    })
}

/// Answers a `clipboard_read` Request (call off the reader thread).
pub fn read(params: &Value) -> Result<Value, String> {
    if let Some(answer) =
        crate::clipboard_history::with(|h| from_history(params, h, Instant::now()))
    {
        return answer;
    }
    let include_image = params["includeImage"].as_bool() == Some(true);
    let content = content(platform::clipboard_read()?, include_image)?;
    serde_json::to_value(content).map_err(|e| e.to_string())
}

/// The answer to a `clipboard_read` with `list` or `index`, or None for the current clipboard.
fn from_history(
    params: &Value,
    history: &crate::clipboard_history::History,
    now: Instant,
) -> Option<Result<Value, String>> {
    if params["list"].as_bool() == Some(true) {
        return Some(Ok(json!({ "entries": history.list(now) })));
    }
    let index = params.get("index").filter(|v| !v.is_null())?;
    let entries = history.list(now).len();
    Some(
        index
            .as_u64()
            .and_then(|i| history.get(i as usize))
            .map(|e| json!({ "kind": "text", "text": e.text }))
            .ok_or_else(|| {
                format!("There is no copy {index}; the clipboard history holds {entries}.")
            }),
    )
}

fn content(raw: Raw, include_image: bool) -> Result<Content, String> {
    Ok(match raw {
        Raw::Empty => Content::Empty,
        Raw::Private => Content::Private,
        Raw::Text(text) => Content::Text { text },
        Raw::Files(paths) => Content::Files { paths },
        Raw::Dib(dib) => {
            let image = decode_dib(&dib).ok_or("the image on the clipboard couldn't be read")?;
            let (width, height) = (image.width, image.height);
            let image = if include_image {
                Some(to_attachment(image)?)
            } else {
                None
            };
            Content::Image {
                image,
                width,
                height,
            }
        }
    })
}

/// Answers a `clipboard_write` Request.
pub fn write(params: &Value) -> Result<Value, String> {
    let text = params["text"].as_str().ok_or("no text to write")?;
    platform::clipboard_write(text)?;
    Ok(Value::Null)
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}
fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}
fn i32_at(b: &[u8], at: usize) -> Option<i32> {
    Some(i32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

const BI_RGB: u32 = 0;
const BI_BITFIELDS: u32 = 3;

/// Width and height from a CF_DIB's header.
pub fn dib_size(dib: &[u8]) -> Option<(u32, u32)> {
    let w = i32_at(dib, 4)?;
    let h = i32_at(dib, 8)?;
    (w > 0 && h != 0).then(|| (w as u32, h.unsigned_abs()))
}

/// A CF_DIB as RGBA: 24 or 32 bits per pixel, uncompressed (BI_RGB, or BI_BITFIELDS with the
/// usual BGRA masks), bottom-up or top-down. 32-bit images with an all-zero alpha are opaque.
pub fn decode_dib(dib: &[u8]) -> Option<RawImage> {
    let header = u32_at(dib, 0)? as usize;
    let (width, height) = dib_size(dib)?;
    let top_down = i32_at(dib, 8)? < 0;
    let bits = u16_at(dib, 14)?;
    let compression = u32_at(dib, 16)?;
    if !matches!(bits, 24 | 32) || !matches!(compression, BI_RGB | BI_BITFIELDS) {
        return None;
    }
    // BI_BITFIELDS with a 40-byte header puts three masks after it.
    let masks = if compression == BI_BITFIELDS && header == 40 {
        12
    } else {
        0
    };
    let start = header + masks;
    let bytes = bits as usize / 8;
    let stride = (width as usize * bytes).div_ceil(4) * 4;
    let pixels = dib.get(start..start + stride * height as usize)?;
    let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
    let mut any_alpha = false;
    for y in 0..height as usize {
        let row = if top_down { y } else { height as usize - 1 - y };
        let line = &pixels[row * stride..row * stride + width as usize * bytes];
        for px in line.chunks_exact(bytes) {
            let a = if bytes == 4 { px[3] } else { 255 };
            any_alpha |= bytes == 4 && a != 0;
            rgba.extend_from_slice(&[px[2], px[1], px[0], a]);
        }
    }
    if bytes == 4 && !any_alpha {
        for px in rgba.as_chunks_mut::<4>().0 {
            px[3] = 255;
        }
    }
    Some(RawImage {
        width,
        height,
        rgba,
    })
}

#[cfg_attr(not(windows), allow(dead_code))]
/// File paths from a CF_HDROP (a DROPFILES header and a double-NUL-terminated list).
pub fn decode_hdrop(data: &[u8]) -> Vec<String> {
    let (Some(offset), Some(wide)) = (u32_at(data, 0), u32_at(data, 16)) else {
        return Vec::new();
    };
    let Some(list) = data.get(offset as usize..) else {
        return Vec::new();
    };
    let text = if wide != 0 {
        let units: Vec<u16> = list
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&c| u16::from_le_bytes(c))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(list).into_owned()
    };
    text.split('\0')
        .take_while(|p| !p.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 2×2 32-bit bottom-up DIB: bottom row red, green; top row blue, white.
    fn dib32(alpha: u8) -> Vec<u8> {
        let mut d = vec![0u8; 40];
        d[0..4].copy_from_slice(&40u32.to_le_bytes());
        d[4..8].copy_from_slice(&2i32.to_le_bytes());
        d[8..12].copy_from_slice(&2i32.to_le_bytes());
        d[12..14].copy_from_slice(&1u16.to_le_bytes());
        d[14..16].copy_from_slice(&32u16.to_le_bytes());
        // BGRA
        d.extend_from_slice(&[0, 0, 255, alpha, 0, 255, 0, alpha]);
        d.extend_from_slice(&[255, 0, 0, alpha, 255, 255, 255, alpha]);
        d
    }

    #[test]
    fn decodes_a_bottom_up_dib_and_makes_zero_alpha_opaque() {
        let image = decode_dib(&dib32(0)).unwrap();
        assert_eq!((image.width, image.height), (2, 2));
        assert_eq!(
            image.rgba,
            vec![0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255]
        );
        assert_eq!(decode_dib(&dib32(128)).unwrap().rgba[3], 128);
    }

    #[test]
    fn decodes_a_padded_24_bit_dib() {
        let mut d = dib32(0)[..40].to_vec();
        d[4..8].copy_from_slice(&1i32.to_le_bytes());
        d[8..12].copy_from_slice(&(-1i32).to_le_bytes());
        d[14..16].copy_from_slice(&24u16.to_le_bytes());
        d.extend_from_slice(&[10, 20, 30, 0]); // one pixel, padded to 4 bytes
        let image = decode_dib(&d).unwrap();
        assert_eq!(image.rgba, vec![30, 20, 10, 255]);
        assert_eq!(decode_dib(&d[..42]), None);
    }

    #[test]
    fn decodes_file_lists() {
        let mut d = vec![0u8; 20];
        d[0..4].copy_from_slice(&20u32.to_le_bytes());
        d[16..20].copy_from_slice(&1u32.to_le_bytes());
        for unit in "C:\\a.txt\0D:\\b c.pdf\0\0".encode_utf16() {
            d.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_hdrop(&d), vec!["C:\\a.txt", "D:\\b c.pdf"]);
        assert!(decode_hdrop(&[1, 2]).is_empty());
    }

    #[test]
    fn notes_kind_and_size_only() {
        assert_eq!(note(None), None);
        assert_eq!(note(Some(Summary::Text(1))).unwrap(), "text, 1 character");
        assert_eq!(
            note(Some(Summary::Text(640))).unwrap(),
            "text, 640 characters"
        );
        assert_eq!(
            note(Some(Summary::Image(800, 600))).unwrap(),
            "image, 800×600"
        );
        assert_eq!(note(Some(Summary::Files(3))).unwrap(), "files, 3 files");
        assert_eq!(note(Some(Summary::Private)).unwrap(), "private");
    }

    #[test]
    fn reads_the_history_by_index_and_lists_it() {
        use crate::clipboard_history::{Change, History};
        let mut h = History::default();
        let t = Instant::now();
        h.observe(1, Change::Text("older".into()), t);
        h.observe(2, Change::Text("newer".into()), t);
        let now = t + std::time::Duration::from_secs(3);
        assert_eq!(
            from_history(&json!({ "includeImage": true }), &h, now),
            None
        );
        assert_eq!(
            from_history(&json!({ "index": 1 }), &h, now),
            Some(Ok(json!({ "kind": "text", "text": "older" })))
        );
        assert_eq!(
            from_history(&json!({ "index": 2 }), &h, now),
            Some(Err(
                "There is no copy 2; the clipboard history holds 2.".into()
            ))
        );
        assert_eq!(
            from_history(&json!({ "list": true }), &h, now),
            Some(Ok(json!({ "entries": [
                { "index": 0, "ageSeconds": 3, "chars": 5, "preview": "newer" },
                { "index": 1, "ageSeconds": 3, "chars": 5, "preview": "older" },
            ] })))
        );
    }

    #[test]
    fn content_matches_the_engine_protocol() {
        let as_json = |raw, img| serde_json::to_value(content(raw, img).unwrap()).unwrap();
        assert_eq!(as_json(Raw::Empty, true), json!({ "kind": "empty" }));
        assert_eq!(as_json(Raw::Private, true), json!({ "kind": "private" }));
        assert_eq!(
            as_json(Raw::Text("hi".into()), true),
            json!({ "kind": "text", "text": "hi" })
        );
        assert_eq!(
            as_json(Raw::Files(vec!["C:\\a".into()]), true),
            json!({ "kind": "files", "paths": ["C:\\a"] })
        );
        assert_eq!(
            as_json(Raw::Dib(dib32(0)), false),
            json!({ "kind": "image", "width": 2, "height": 2 })
        );
        let with = as_json(Raw::Dib(dib32(0)), true);
        assert_eq!(with["image"]["mimeType"], "image/png");
        assert!(content(Raw::Dib(vec![1, 2, 3]), true).is_err());
    }
}
