//! Clipboard history (docs/ARCHITECTURE.md, "Clipboard history"): the last 20 text entries the
//! user copied while Winku runs, newest first, in memory only.
//!
//! This module is pure: the platform's clipboard listener reports each change with its
//! clipboard sequence number, and Winku's own clipboard use (the selection capture and the
//! paste-back) opens and closes "own" spans of sequence numbers whose changes are skipped.
//!
//! Winku marks what it leaves on the clipboard with the formats that keep it out of clipboard
//! history, the same mark a password manager uses. The history remembers the last state Winku
//! left, and whether it was private before Winku touched it, so `private` can tell the two
//! apart however many spans have passed since.
// Only the Windows listener and selection capture write to the history.
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;

pub const CAP: usize = 20;
const PREVIEW_CHARS: usize = 60;
/// Own spans kept for lookups after they close.
const OWN_SPANS: usize = 8;

/// What the clipboard holds after a change.
#[derive(Clone, Debug, PartialEq)]
pub enum Change {
    Text(String),
    /// Marked private by a password manager (or by Winku, see `own`).
    Private,
    /// An image, files, or nothing: not recorded.
    Other,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub text: String,
    pub at: Instant,
}

/// One row of `list`: `ClipboardHistoryEntry` in engine/src/protocol.ts.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub index: usize,
    pub age_seconds: u64,
    pub chars: usize,
    pub preview: String,
}

/// Changes Winku makes itself: those with a sequence number after `after` and up to `until`
/// (open while `until` is None).
#[derive(Clone, Copy, Debug)]
struct Own {
    id: u64,
    after: u32,
    until: Option<u32>,
    /// What Winku left on the clipboard was private before Winku touched it.
    private: bool,
}

/// What Winku last left on the clipboard: its sequence number, and whether that content was
/// private before Winku touched it.
#[derive(Clone, Copy, Debug)]
struct Left {
    seq: u32,
    private: bool,
}

#[derive(Debug, Default)]
pub struct History {
    entries: VecDeque<Entry>,
    own: VecDeque<Own>,
    next_id: u64,
    left: Option<Left>,
}

impl History {
    /// A clipboard change, as the listener read it at sequence number `seq`.
    pub fn observe(&mut self, seq: u32, change: Change, at: Instant) {
        if self.own(seq).is_some() || self.left.is_some_and(|l| l.seq == seq) {
            return;
        }
        let Change::Text(text) = change else { return };
        if text.is_empty() {
            return;
        }
        self.entries.retain(|e| e.text != text);
        self.entries.push_front(Entry { text, at });
        self.entries.truncate(CAP);
    }

    /// Winku is about to change the clipboard; `seq` is the sequence number now. Returns an id
    /// for `end_own`.
    pub fn begin_own(&mut self, seq: u32) -> u64 {
        self.next_id += 1;
        self.own.push_back(Own {
            id: self.next_id,
            after: seq,
            until: None,
            private: false,
        });
        while self.own.len() > OWN_SPANS {
            self.own.pop_front();
        }
        self.next_id
    }

    /// Winku is done; `seq` is the sequence number of what it left on the clipboard, and
    /// `private` says whether that content was private before Winku touched it.
    /// A span that changed nothing leaves the record of what Winku last left alone.
    pub fn end_own(&mut self, id: u64, seq: u32, private: bool) {
        let Some(span) = self.own.iter_mut().find(|s| s.id == id) else {
            return;
        };
        span.until = Some(seq);
        span.private = private;
        if seq != span.after && self.left.is_none_or(|l| seq >= l.seq) {
            self.left = Some(Left { seq, private });
        }
    }

    /// Whether the content at `seq` is private, given whether it carries the exclude-from-history
    /// mark (`marked`). A mark Winku put there itself counts only if the content was private
    /// before Winku touched it; any other mark is a password manager's.
    pub fn private(&self, seq: u32, marked: bool) -> bool {
        if !marked {
            return false;
        }
        match self.left {
            Some(left) if left.seq == seq => left.private,
            _ => self.own(seq) != Some(false),
        }
    }

    /// Some(private) when the change at `seq` was Winku's own.
    pub fn own(&self, seq: u32) -> Option<bool> {
        self.own
            .iter()
            .find(|s| seq > s.after && s.until.is_none_or(|until| seq <= until))
            .map(|s| s.private)
    }

    /// Entry `index`, 0 being the newest.
    pub fn get(&self, index: usize) -> Option<&Entry> {
        self.entries.get(index)
    }

    /// Every entry, newest first, as index, age and a one-line preview.
    pub fn list(&self, now: Instant) -> Vec<Listed> {
        self.entries
            .iter()
            .enumerate()
            .map(|(index, e)| Listed {
                index,
                age_seconds: now.saturating_duration_since(e.at).as_secs(),
                chars: e.text.chars().count(),
                preview: preview(&e.text),
            })
            .collect()
    }
}

/// The text on one line, whitespace collapsed, cut at 60 characters with an ellipsis.
fn preview(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= PREVIEW_CHARS {
        line
    } else {
        let cut: String = line.chars().take(PREVIEW_CHARS - 1).collect();
        format!("{}…", cut.trim_end())
    }
}

/// The history of this run.
pub static HISTORY: Mutex<History> = Mutex::new(History {
    entries: VecDeque::new(),
    own: VecDeque::new(),
    next_id: 0,
    left: None,
});

pub fn with<T>(f: impl FnOnce(&mut History) -> T) -> T {
    f(&mut HISTORY.lock().unwrap_or_else(|e| e.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn after(base: Instant, secs: u64) -> Instant {
        base + Duration::from_secs(secs)
    }

    fn text(s: &str) -> Change {
        Change::Text(s.into())
    }

    fn texts(h: &History) -> Vec<String> {
        h.entries.iter().map(|e| e.text.clone()).collect()
    }

    #[test]
    fn keeps_text_newest_first_capped_at_20() {
        let mut h = History::default();
        let t = Instant::now();
        for i in 0..25u32 {
            h.observe(i + 1, text(&format!("copy {i}")), t);
        }
        assert_eq!(h.list(t).len(), 20);
        assert_eq!(h.get(0).unwrap().text, "copy 24");
        assert_eq!(h.get(19).unwrap().text, "copy 5");
        assert!(h.get(20).is_none());
    }

    #[test]
    fn skips_private_images_files_and_empty_text() {
        let mut h = History::default();
        let t = Instant::now();
        h.observe(1, text("mine"), t);
        h.observe(2, Change::Private, t);
        h.observe(3, Change::Other, t);
        h.observe(4, text(""), t);
        assert_eq!(texts(&h), vec!["mine"]);
    }

    #[test]
    fn copying_the_same_text_again_moves_it_to_the_front() {
        let mut h = History::default();
        let t = Instant::now();
        h.observe(1, text("a"), t);
        h.observe(2, text("b"), t);
        h.observe(3, text("a"), after(t, 5));
        assert_eq!(texts(&h), vec!["a", "b"]);
        assert_eq!(h.get(0).unwrap().at, after(t, 5));
    }

    #[test]
    fn skips_winkus_own_changes() {
        let mut h = History::default();
        let t = Instant::now();
        h.observe(10, text("user copy"), t);
        // Selection capture: the app's copy (11) and Winku's restore (12).
        let span = h.begin_own(10);
        h.observe(11, text("selected words"), t);
        h.end_own(span, 12, false);
        h.observe(12, text("user copy"), t);
        // Paste-back: Winku's text (13), then the restore (14).
        let paste = h.begin_own(12);
        h.end_own(paste, 13, false);
        h.observe(13, text("rewritten words"), t);
        let restore = h.begin_own(13);
        h.end_own(restore, 14, false);
        h.observe(14, text("user copy"), t);
        // The user copies again, then clipboard_write writes: both are the user's.
        h.observe(15, text("next copy"), t);
        h.observe(16, text("written by the assistant"), t);
        assert_eq!(
            texts(&h),
            vec!["written by the assistant", "next copy", "user copy"]
        );
    }

    #[test]
    fn an_open_own_span_covers_every_later_change() {
        let mut h = History::default();
        let span = h.begin_own(5);
        assert_eq!(h.own(5), None);
        assert_eq!(h.own(6), Some(false));
        assert_eq!(h.own(60), Some(false));
        h.end_own(span, 7, true);
        assert_eq!(h.own(7), Some(true));
        assert_eq!(h.own(8), None);
    }

    #[test]
    fn a_restored_ordinary_copy_stays_readable_after_many_own_spans() {
        let mut h = History::default();
        let t = Instant::now();
        h.observe(10, text("user copy"), t);
        // A selection capture: the app's copy (11), Winku's restore (12) carries the mark.
        let span = h.begin_own(10);
        h.end_own(span, 12, false);
        assert!(!h.private(12, true));
        // Many captures that changed nothing, each seeing the mark Winku left.
        for _ in 0..(OWN_SPANS + 2) {
            let span = h.begin_own(12);
            h.end_own(span, 12, true);
        }
        assert!(!h.private(12, true), "still the user's ordinary copy");
        // A late message for the restore is still Winku's own.
        h.observe(12, text("restored"), t);
        assert_eq!(texts(&h), vec!["user copy"]);
    }

    #[test]
    fn password_manager_content_stays_private() {
        let mut h = History::default();
        // Marked by a password manager, Winku never touched it.
        assert!(h.private(20, true));
        // A capture over it restores it private.
        let span = h.begin_own(20);
        h.end_own(span, 22, true);
        assert!(h.private(22, true));
        // An ordinary copy restored earlier doesn't excuse a later marked copy.
        let span = h.begin_own(22);
        h.end_own(span, 24, false);
        assert!(h.private(25, true));
        // Unmarked content is never private.
        assert!(!h.private(25, false));
    }

    #[test]
    fn lists_index_age_and_a_one_line_preview() {
        let mut h = History::default();
        let t = Instant::now();
        h.observe(1, text("first\n  line two"), t);
        let long = "word ".repeat(30);
        h.observe(2, text(&long), after(t, 90));
        let list = h.list(after(t, 120));
        assert_eq!(
            list[1],
            Listed {
                index: 1,
                age_seconds: 120,
                chars: 16,
                preview: "first line two".into()
            }
        );
        assert_eq!(list[0].index, 0);
        assert_eq!(list[0].age_seconds, 30);
        assert_eq!(list[0].chars, 150);
        assert_eq!(list[0].preview.chars().count(), 60);
        assert!(list[0].preview.starts_with("word word") && list[0].preview.ends_with("…"));
    }
}
