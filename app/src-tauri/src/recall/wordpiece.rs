//! BERT's uncased WordPiece tokenizer, as Hugging Face's `BertTokenizer` runs it with
//! `do_lower_case`, `tokenize_chinese_chars` and the default accent stripping: enough for
//! bge-small-en-v1.5's vocab.txt. Checked token for token against HF on tricky input (the
//! ignored `matches_hugging_face` test).

use std::collections::HashMap;

use unicode_normalization::UnicodeNormalization;
use unicode_properties::{GeneralCategory, GeneralCategoryGroup, UnicodeGeneralCategory};

const CLS: &str = "[CLS]";
const SEP: &str = "[SEP]";
const UNK: &str = "[UNK]";
/// Words longer than this many characters become [UNK], as in HF.
const MAX_WORD_CHARS: usize = 100;

pub struct WordPiece {
    vocab: HashMap<String, i64>,
    unk: i64,
    pub cls: i64,
    pub sep: i64,
}

impl WordPiece {
    /// vocab.txt: one token per line, the line number is its id.
    pub fn from_vocab(text: &str) -> Result<Self, String> {
        let vocab: HashMap<String, i64> = text
            .lines()
            .enumerate()
            .map(|(i, line)| (line.trim_end_matches('\r').to_string(), i as i64))
            .collect();
        let id = |t: &str| {
            vocab
                .get(t)
                .copied()
                .ok_or_else(|| format!("vocab.txt has no {t}"))
        };
        Ok(Self {
            unk: id(UNK)?,
            cls: id(CLS)?,
            sep: id(SEP)?,
            vocab,
        })
    }

    /// Token ids for `text`, without [CLS]/[SEP], at most `max` of them (the rest is cut).
    pub fn encode(&self, text: &str, max: usize) -> Vec<i64> {
        let mut ids = Vec::new();
        for word in basic_tokens(text) {
            if ids.len() >= max {
                break;
            }
            self.word_pieces(&word, &mut ids);
        }
        ids.truncate(max);
        ids
    }

    /// Greedy longest-match-first pieces; a word with any part outside the vocab is one [UNK].
    fn word_pieces(&self, word: &str, out: &mut Vec<i64>) {
        let chars: Vec<char> = word.chars().collect();
        if chars.len() > MAX_WORD_CHARS {
            out.push(self.unk);
            return;
        }
        let mut pieces = Vec::new();
        let mut start = 0;
        while start < chars.len() {
            let mut end = chars.len();
            let mut found = None;
            while start < end {
                let mut piece: String = chars[start..end].iter().collect();
                if start > 0 {
                    piece.insert_str(0, "##");
                }
                if let Some(&id) = self.vocab.get(&piece) {
                    found = Some(id);
                    break;
                }
                end -= 1;
            }
            let Some(id) = found else {
                out.push(self.unk);
                return;
            };
            pieces.push(id);
            start = end;
        }
        out.extend(pieces);
    }
}

fn is_control(c: char) -> bool {
    if matches!(c, '\t' | '\n' | '\r') {
        return false;
    }
    matches!(c.general_category_group(), GeneralCategoryGroup::Other)
}

fn is_whitespace(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r') || c.general_category() == GeneralCategory::SpaceSeparator
}

/// Every non-alphanumeric ASCII character counts, like HF (`$`, `^`, backtick…), plus Unicode
/// punctuation.
fn is_punctuation(c: char) -> bool {
    c.is_ascii_punctuation() || c.general_category_group() == GeneralCategoryGroup::Punctuation
}

/// The CJK Unified Ideographs blocks BERT splits into single characters (not kana or hangul).
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x20000..=0x2A6DF | 0x2A700..=0x2B73F
        | 0x2B740..=0x2B81F | 0x2B820..=0x2CEAF | 0xF900..=0xFAFF | 0x2F800..=0x2FA1F)
}

/// Drops control characters, splits on whitespace, lower-cases, strips accents, and splits off
/// punctuation and CJK characters as words of their own.
fn basic_tokens(text: &str) -> Vec<String> {
    let mut spaced = String::with_capacity(text.len());
    for c in text.chars() {
        if c == '\0' || c == '\u{FFFD}' || is_control(c) {
            continue;
        }
        if is_whitespace(c) {
            spaced.push(' ');
        } else if is_cjk(c) {
            spaced.push(' ');
            spaced.push(c);
            spaced.push(' ');
        } else {
            spaced.push(c);
        }
    }
    let mut tokens = Vec::new();
    for word in spaced.split(' ').filter(|w| !w.is_empty()) {
        let plain: String = word
            .to_lowercase()
            .nfd()
            .filter(|c| c.general_category() != GeneralCategory::NonspacingMark)
            .collect();
        let mut current = String::new();
        for c in plain.chars() {
            if is_punctuation(c) {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
                tokens.push(c.to_string());
            } else {
                current.push(c);
            }
        }
        if !current.is_empty() {
            tokens.push(current);
        }
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    const VOCAB: &[&str] = &[
        "[PAD]", "[UNK]", "[CLS]", "[SEP]", "hello", "world", ",", "!", "un", "##aff", "##able",
        "cafe", "resume", "日", "本", "the", "'", "s", "-", "x",
    ];

    fn tokenizer() -> WordPiece {
        WordPiece::from_vocab(&VOCAB.join("\n")).unwrap()
    }

    fn id(token: &str) -> i64 {
        VOCAB.iter().position(|t| *t == token).unwrap() as i64
    }

    fn ids(tokens: &[&str]) -> Vec<i64> {
        tokens.iter().map(|t| id(t)).collect()
    }

    #[test]
    fn specials_come_from_the_vocab() {
        let wp = tokenizer();
        assert_eq!((wp.cls, wp.sep, wp.unk), (2, 3, 1));
        assert!(WordPiece::from_vocab("[CLS]\n[SEP]").is_err(), "no [UNK]");
        // Windows line endings.
        let crlf = WordPiece::from_vocab("[UNK]\r\n[CLS]\r\n[SEP]\r\nhello\r\n").unwrap();
        assert_eq!(crlf.encode("Hello", 10), [3]);
    }

    #[test]
    fn splits_words_and_punctuation_and_lower_cases() {
        let wp = tokenizer();
        assert_eq!(
            wp.encode("Hello,  WORLD!", 99),
            ids(&["hello", ",", "world", "!"])
        );
        assert_eq!(
            wp.encode("the world's\tx-x", 99),
            ids(&["the", "world", "'", "s", "x", "-", "x"])
        );
    }

    #[test]
    fn strips_accents() {
        let wp = tokenizer();
        assert_eq!(wp.encode("Café RÉSUMÉ", 99), ids(&["cafe", "resume"]));
    }

    #[test]
    fn splits_cjk_characters() {
        let wp = tokenizer();
        assert_eq!(
            wp.encode("hello日本world", 99),
            ids(&["hello", "日", "本", "world"])
        );
    }

    #[test]
    fn word_pieces_and_unknown_words() {
        let wp = tokenizer();
        assert_eq!(wp.encode("unaffable", 99), ids(&["un", "##aff", "##able"]));
        // Any piece missing makes the whole word one [UNK].
        assert_eq!(wp.encode("unzzz hello", 99), ids(&["[UNK]", "hello"]));
        assert_eq!(wp.encode(&"x".repeat(101), 99), ids(&["[UNK]"]));
    }

    #[test]
    fn drops_control_characters_and_caps_the_length() {
        let wp = tokenizer();
        assert_eq!(
            wp.encode("hel\u{0}lo\u{200B} \u{FFFD}world", 99),
            ids(&["hello", "world"])
        );
        assert_eq!(wp.encode("unaffable hello", 2), ids(&["un", "##aff"]));
        assert!(wp.encode("", 10).is_empty());
        assert!(wp.encode("hello", 0).is_empty());
    }

    /// Ids from Hugging Face's tokenizer for bge-small-en-v1.5 (no special tokens). Needs the
    /// real vocab: `WINKU_EMBED_E2E=<folder with vocab.txt> cargo test wordpiece -- --ignored`.
    #[test]
    #[ignore]
    fn matches_hugging_face() {
        let Some(dir) = std::env::var_os("WINKU_EMBED_E2E") else {
            eprintln!("WINKU_EMBED_E2E not set; skipping");
            return;
        };
        let vocab = std::fs::read_to_string(std::path::Path::new(&dir).join("vocab.txt")).unwrap();
        let wp = WordPiece::from_vocab(&vocab).unwrap();
        let golden: &[(&str, &[i64])] = &[
            (
                "Hello, World! It's 3:45pm — naïve café résumé.",
                &[
                    7592, 1010, 2088, 999, 2009, 1005, 1055, 1017, 1024, 3429, 9737, 1517, 15743,
                    7668, 13746, 1012,
                ],
            ),
            (
                "Rajat's Winku app (v0.1.11) uses `cargo build --release` && bun.",
                &[
                    10164, 2102, 1005, 1055, 16837, 2226, 10439, 1006, 1058, 2692, 1012, 1015,
                    1012, 2340, 1007, 3594, 1036, 6636, 3857, 1011, 1011, 2713, 1036, 1004, 1004,
                    21122, 1012,
                ],
            ),
            (
                "東京に住んでいます and 北京 too 🙂 emoji!",
                &[
                    1879, 1755, 1668, 100, 1691, 30191, 30173, 30203, 30184, 1998, 1781, 1755,
                    2205, 100, 7861, 29147, 2072, 999,
                ],
            ),
            (
                "supercalifragilisticexpialidocious unbelievably tokenization-heavy_text",
                &[
                    3565, 9289, 10128, 29181, 24411, 4588, 10288, 19312, 21273, 10085, 6313, 4895,
                    8671, 2666, 3567, 6321, 19204, 3989, 1011, 3082, 1035, 3793,
                ],
            ),
            (
                "Ünïcödé ÀÉÎÕÜ ß straße  tabs\tand",
                &[
                    27260, 29347, 3695, 2226, 1096, 2358, 27807, 21628, 2015, 1998,
                ],
            ),
            (
                "newlines... \"quotes\" 'single' {braces} [brackets] <tags> #hash @at $5.00 100%",
                &[
                    2047, 12735, 1012, 1012, 1012, 1000, 16614, 1000, 1005, 2309, 1005, 1063,
                    17180, 2015, 1065, 1031, 19719, 1033, 1026, 22073, 1028, 1001, 23325, 1030,
                    2012, 1002, 1019, 1012, 4002, 2531, 1003,
                ],
            ),
        ];
        for (text, expected) in golden {
            assert_eq!(wp.encode(text, 10_000), *expected, "{text}");
        }
    }
}
