//! Visuals (SPEC §3): pages the assistant draws into a reply. The engine saves each one as
//! `visuals\<id>.html` in the data folder; this serves them from Winku's own URL scheme,
//! `winku-visual` (`http://winku-visual.localhost/<id>.html` on Windows), with a CSP of their own
//! (docs/adr/0001-visuals-load-from-the-web.md). The main window shows them in sandboxed frames
//! (`allow-scripts` only, so an opaque origin): the page can't reach the app, the disk, the engine
//! or the thread. The only way out is `postMessage` to the frame's parent, which the bridge uses
//! to report the page's height and its script errors.

use std::borrow::Cow;
use std::path::Path;

use tauri::http::{header, Request, Response, StatusCode};

pub const SCHEME: &str = "winku-visual";

/// A visual's own policy: inline and remote (https) scripts, styles, pictures and fonts, and
/// nothing else. No fetch, no forms, no nested frames, no navigation away.
pub const CSP: &str = "default-src 'none'; \
     script-src 'unsafe-inline' 'unsafe-eval' https:; \
     style-src 'unsafe-inline' https:; \
     img-src https: data: blob:; \
     font-src https: data:; \
     media-src https: data: blob:; \
     connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/// Winku's palette and fonts as CSS variables, a bare base (no background, a small margin for focus
/// rings) and the house style for charts. Inserted ahead of the page's own styles.
pub const STYLE: &str = include_str!("visual-style.css");

/// Runs first in every page. It reports the page's height whenever it changes, uncaught errors
/// and failed loads, and `loaded` once the page has loaded. The page never scrolls by itself.
/// Keep the message shape in step with app/ui/src/main/Visual.svelte.
pub const BRIDGE: &str = concat!("<script>", include_str!("bridge.js"), "</script>");

/// The visual id in a request path, `/<16 hex>.html`; anything else is not a visual.
pub fn visual_id(path: &str) -> Option<&str> {
    let id = path.strip_prefix('/')?.strip_suffix(".html")?;
    (id.len() == 16 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        .then_some(id)
}

/// The page with the bridge as the first thing in it: just inside `<head>`, else just inside
/// `<html>`, else after the doctype, else at the very start. The file itself stays as written.
pub fn with_bridge(page: &str) -> String {
    insert_first(page, &format!("<style id=\"winku-style\">{STYLE}</style>{BRIDGE}"))
}

/// The page for "Open in browser": the visual policy as a `<meta>` (no response header there),
/// then Winku's style, first in the page. No bridge: nothing is listening.
pub fn browser_page(page: &str) -> String {
    insert_first(
        page,
        &format!(
            "<meta http-equiv=\"Content-Security-Policy\" content=\"{CSP}\"><style id=\"winku-style\">{STYLE}</style>"
        ),
    )
}

/// Writes the browser copy of a saved visual to `out_dir\<id>.html` and returns its path; `None`
/// unless `id` is a saved visual.
pub fn browser_copy(data_dir: &Path, id: &str, out_dir: &Path) -> Option<std::path::PathBuf> {
    let page = std::fs::read_to_string(saved_file(data_dir, id)?).ok()?;
    std::fs::create_dir_all(out_dir).ok()?;
    let copy = out_dir.join(format!("{id}.html"));
    std::fs::write(&copy, browser_page(&page)).ok()?;
    Some(copy)
}

/// `inserted` as the first thing in the page: just inside `<head>`, else just inside `<html>`,
/// else after the doctype, else at the very start.
fn insert_first(page: &str, inserted: &str) -> String {
    let lower = page.to_ascii_lowercase();
    let after_tag = |name: &str| -> Option<usize> {
        let mut from = 0;
        while let Some(at) = lower[from..].find(name) {
            let start = from + at;
            let next = lower.as_bytes().get(start + name.len()).copied();
            if matches!(next, Some(b'>' | b' ' | b'\t' | b'\n' | b'\r' | b'/')) {
                return lower[start..].find('>').map(|end| start + end + 1);
            }
            from = start + name.len();
        }
        None
    };
    let at = after_tag("<head")
        .or_else(|| after_tag("<html"))
        .or_else(|| after_tag("<!doctype"))
        .unwrap_or(0);
    let mut out = String::with_capacity(page.len() + inserted.len());
    out.push_str(&page[..at]);
    out.push_str(inserted);
    out.push_str(&page[at..]);
    out
}

/// A saved visual's file, for "Open in browser"; `None` unless `id` is a visual id and the file
/// exists.
pub fn saved_file(data_dir: &Path, id: &str) -> Option<std::path::PathBuf> {
    visual_id(&format!("/{id}.html"))?;
    let file = data_dir.join("visuals").join(format!("{id}.html"));
    file.is_file().then_some(file)
}

/// Answers a `winku-visual` request from `data_dir\visuals`.
pub fn serve(data_dir: &Path, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let plain = |status: StatusCode, text: &'static str| {
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .header("Content-Security-Policy", CSP)
            .body(Cow::Borrowed(text.as_bytes()))
            .expect("static response")
    };
    if request.method() != "GET" {
        return plain(StatusCode::METHOD_NOT_ALLOWED, "Not allowed");
    }
    let Some(id) = visual_id(request.uri().path()) else {
        return plain(StatusCode::NOT_FOUND, "No such visual");
    };
    let Ok(page) = std::fs::read_to_string(data_dir.join("visuals").join(format!("{id}.html")))
    else {
        return plain(StatusCode::NOT_FOUND, "No such visual");
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header("Content-Security-Policy", CSP)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .body(Cow::Owned(with_bridge(&page).into_bytes()))
        .expect("visual response")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inserted() -> String {
        format!("<style id=\"winku-style\">{STYLE}</style>{BRIDGE}")
    }

    #[test]
    fn open_in_browser_opens_a_copy_under_the_visual_policy() {
        let dir = std::env::temp_dir().join(format!("winku-visual-copy-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("visuals")).unwrap();
        let page = "<!doctype html><html><head><title>t</title></head><body><script>x()</script></body></html>";
        std::fs::write(dir.join("visuals").join("00000000000000ee.html"), page).unwrap();
        let out = dir.join("browser");
        let copy = browser_copy(&dir, "00000000000000ee", &out).unwrap();
        assert_eq!(copy, out.join("00000000000000ee.html"));
        let text = std::fs::read_to_string(&copy).unwrap();
        let meta = format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{CSP}\">");
        assert!(text.starts_with(&format!("<!doctype html><html><head>{meta}<style id=\"winku-style\">{STYLE}</style><title>")));
        assert!(!text.contains("winku: \"visual\"") && !text.contains(include_str!("bridge.js")));
        assert!(text.ends_with("<script>x()</script></body></html>"));
        // The saved file stays as written.
        assert_eq!(std::fs::read_to_string(dir.join("visuals").join("00000000000000ee.html")).unwrap(), page);
        assert_eq!(browser_copy(&dir, "../settings", &out), None);
        assert_eq!(browser_copy(&dir, "00000000000000dd", &out), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn open_in_browser_finds_only_saved_visuals() {
        let dir = std::env::temp_dir().join(format!("winku-visual-file-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("visuals")).unwrap();
        std::fs::write(dir.join("visuals").join("00000000000000cc.html"), "<p>x</p>").unwrap();
        assert_eq!(
            saved_file(&dir, "00000000000000cc"),
            Some(dir.join("visuals").join("00000000000000cc.html"))
        );
        assert_eq!(saved_file(&dir, "00000000000000dd"), None);
        assert_eq!(saved_file(&dir, "../settings"), None);
        assert_eq!(saved_file(&dir, "00000000000000CC"), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_visual_files_are_served() {
        assert_eq!(
            visual_id("/0123456789abcdef.html"),
            Some("0123456789abcdef")
        );
        for path in [
            "/0123456789ABCDEF.html",
            "/0123456789abcde.html",
            "/../settings.json",
            "/..%2f0123456789abcdef.html",
            "/sub/0123456789abcdef.html",
            "/0123456789abcdef.htm",
            "0123456789abcdef.html",
        ] {
            assert_eq!(visual_id(path), None, "{path}");
        }
    }

    #[test]
    fn the_bridge_runs_before_the_page() {
        let ins = inserted();
        let page = "<!doctype html><html lang=en><head><title>x</title></head><body>hi</body></html>";
        assert_eq!(
            with_bridge(page),
            format!("<!doctype html><html lang=en><head>{ins}<title>x</title></head><body>hi</body></html>")
        );
        assert_eq!(
            with_bridge("<HTML><Body>x</Body></HTML>"),
            format!("<HTML>{ins}<Body>x</Body></HTML>")
        );
        assert_eq!(
            with_bridge("<!DOCTYPE html><p>x</p>"),
            format!("<!DOCTYPE html>{ins}<p>x</p>")
        );
        assert_eq!(with_bridge("<p>x</p>"), format!("{ins}<p>x</p>"));
        // <header> is not <head>.
        assert_eq!(
            with_bridge("<header>h</header>"),
            format!("{ins}<header>h</header>")
        );
    }

    #[test]
    fn serves_the_saved_page_with_its_own_policy() {
        let dir = std::env::temp_dir().join(format!("winku-visuals-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("visuals")).unwrap();
        std::fs::write(dir.join("visuals").join("00000000000000aa.html"), "<p>chart</p>").unwrap();
        let ins = inserted();
        let get = |uri: &str| serve(&dir, &Request::get(uri).body(Vec::new()).unwrap());

        let ok = get("http://winku-visual.localhost/00000000000000aa.html");
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers()["Content-Security-Policy"], CSP);
        assert_eq!(
            String::from_utf8(ok.body().to_vec()).unwrap(),
            format!("{ins}<p>chart</p>")
        );
        assert_eq!(
            get("winku-visual://localhost/00000000000000bb.html").status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            get("winku-visual://localhost/settings.json").status(),
            StatusCode::NOT_FOUND
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[cfg(test)]
mod style_tests {
    use super::*;

    #[test]
    fn pages_start_with_winkus_palette_and_a_bare_base() {
        for var in ["--text:", "--muted:", "--accent:#5ef6f0", "--hot:", "--font:", "--mono:"] {
            assert!(STYLE.contains(var), "{var}");
        }
        assert!(STYLE.contains("html,body{background:transparent}"));
        assert!(STYLE.contains("body{margin:4px}"));
        // Styles come before the page's own, and before the bridge's first measurement.
        let page = with_bridge("<head><style>p{color:red}</style></head>");
        let at = |needle: &str| page.find(needle).unwrap();
        assert!(at("winku-style") < at("p{color:red}"));
        assert!(at("winku-style") < at(BRIDGE));
    }

    #[test]
    fn the_house_style_has_dot_bars_with_no_unlit_dots_and_no_motion_when_reduced() {
        assert!(STYLE.contains(".w-bars") && STYLE.contains(".w-dots") && STYLE.contains(".w-bar.hot"));
        // Lit dots only: the dot background is on the bar's own height, never a full-height grid.
        assert!(STYLE.contains("height:calc(var(--rows)*8px)"));
        assert!(STYLE.contains("@media (prefers-reduced-motion:reduce){.w-dots,.w-rise{animation:none}}"));
        // The dots rise once.
        assert!(!STYLE.contains("infinite"));
    }
}
