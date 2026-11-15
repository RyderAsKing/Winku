//! Text as the voice should read it. Supertonic reads characters, and its preprocessing drops
//! or blanks `# [ ] | \ _ ` @` and has no entry for `=`, `^`, `{` or `}`, so symbols, markdown,
//! links and paths are spelled out or shortened here, before any voice sees them.

use std::sync::LazyLock;

use regex::{Captures, Regex};

/// `text` rewritten for listening.
pub fn to_speech(text: &str) -> String {
    let text = versions(&dates(&emails(&paths(&links(&markdown(text))))));
    symbols(&leftovers(&text))
}

/// "me@example.com" as "me at example dot com".
fn emails(text: &str) -> String {
    static EMAIL: LazyLock<Regex> =
        LazyLock::new(|| re(r"\b([\w.+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b"));
    EMAIL
        .replace_all(text, |c: &Captures| {
            format!("{} at {}", &c[1], dotted(&c[2]))
        })
        .into_owned()
}

/// Typographic quotes, dashes and ellipses as the plain ones the voice knows, the characters it
/// drops or blanks anyway (`_ * # ` | \ [ ] { } ^ @`) as spaces, and emoji and other symbols it
/// has no sound for removed.
fn leftovers(text: &str) -> String {
    // `symbols` says the operators (and the arrow) afterwards.
    const SAYABLE: &str = "!\"$%&'()+,-./:;<=>?~£¥¢€°→";
    let plain = text
        .replace(['\u{2018}', '\u{2019}', '\u{2032}'], "'")
        .replace(['\u{201c}', '\u{201d}', '\u{2033}'], "\"")
        .replace(['\u{2014}', '\u{2015}'], ", ")
        .replace(
            ['\u{2010}', '\u{2011}', '\u{2012}', '\u{2013}', '\u{2212}'],
            "-",
        )
        .replace('\u{2026}', "...");
    plain
        .lines()
        .map(|line| {
            line.chars()
                .map(|c| {
                    let sayable = c.is_alphanumeric() || is_mark(c) || SAYABLE.contains(c);
                    if sayable {
                        c
                    } else {
                        ' '
                    }
                })
                .collect::<String>()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// A combining accent, kept with its letter.
fn is_mark(c: char) -> bool {
    matches!(c, '\u{0300}'..='\u{036f}')
}

/// Markdown as plain lines: code blocks and tables are left on screen and mentioned once,
/// headings, quotes, list markers and emphasis are dropped, and a link is said as its text.
fn markdown(text: &str) -> String {
    static LINK: LazyLock<Regex> = LazyLock::new(|| re(r"!?\[([^\]]*)\]\([^)]*\)"));
    static MARKER: LazyLock<Regex> =
        LazyLock::new(|| re(r"^(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)+"));
    static EMPHASIS: LazyLock<Regex> = LazyLock::new(|| re(r"(\*\*|__|~~|`)(.+?)(\*\*|__|~~|`)"));
    static SINGLE: LazyLock<Regex> =
        LazyLock::new(|| re(r"(^|[\s(])[*_]([^*_\s][^*_]*?)[*_]([\s.,;:!?)]|$)"));
    static TIMES: LazyLock<Regex> = LazyLock::new(|| re(r"(\d)\s*\*\s*(\d)"));
    let mut lines = Vec::new();
    let (mut in_code, mut code_noted, mut table_noted) = (false, false, false);
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with("```") || line.starts_with("~~~") {
            in_code = !in_code;
            if in_code && !code_noted {
                lines.push("The code is in the bar.".to_string());
                code_noted = true;
            }
            continue;
        }
        if in_code {
            continue;
        }
        if line.len() > 1 && line.starts_with('|') && line.ends_with('|') {
            if !table_noted {
                lines.push("The table is in the bar.".to_string());
                table_noted = true;
            }
            continue;
        }
        if line.len() >= 3 && line.chars().all(|c| matches!(c, '-' | '*' | '_')) {
            continue; // a horizontal rule
        }
        let line = MARKER.replace(line, "");
        let line = LINK.replace_all(&line, "$1");
        let line = EMPHASIS.replace_all(&line, "$2");
        let line = SINGLE.replace_all(&line, "$1$2$3");
        let line = TIMES.replace_all(&line, "$1 times $2");
        lines.push(line.into_owned());
    }
    lines.join("\n")
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a valid pattern")
}

/// A URL is said as its site: "github dot com", not the whole address.
fn links(text: &str) -> String {
    static URL: LazyLock<Regex> = LazyLock::new(|| {
        re(r"<?\bhttps?://(?:www\.)?([A-Za-z0-9.-]+)(?::\d+)?(?:[/?#][^\s<>]*)?>?")
    });
    URL.replace_all(text, |c: &Captures| {
        // Sentence punctuation right after a link isn't part of it.
        let whole = &c[0];
        let kept = whole.trim_end_matches(['.', ',', ';', ':', '!', '?', ')']);
        let site = dotted(c[1].trim_end_matches('-'));
        format!("{site}{}", &whole[kept.len()..])
    })
    .into_owned()
}

/// A file path is said as its last part: the file or folder name, not the whole path.
fn paths(text: &str) -> String {
    static PATH: LazyLock<Regex> = LazyLock::new(|| {
        re(r#"(^|[\s("'])((?:[A-Za-z]:\\|\\\\|~[/\\]|\.{1,2}[/\\]|/)[^\s"'<>]*)"#)
    });
    PATH.replace_all(text, |c: &Captures| {
        let path = &c[2];
        let kept = path.trim_end_matches(['.', ',', ';', ':', '!', '?', ')']);
        let name = kept.split(['/', '\\']).rfind(|part| !part.is_empty());
        match name {
            Some(name) if name != "~" && name.chars().any(char::is_alphanumeric) => {
                format!("{}{}{}", &c[1], dotted(name), &path[kept.len()..])
            }
            _ => c[0].to_string(),
        }
    })
    .into_owned()
}

/// "report.pdf" as "report dot pdf".
fn dotted(name: &str) -> String {
    name.trim_matches('.').replace('.', " dot ")
}

/// "2026-11-15" and "11/15/2026" as "November 15, 2026". Slashed dates read month first unless
/// the first number is over 12; two-digit years are this century.
fn dates(text: &str) -> String {
    const MONTHS: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    fn said(year: &str, month: u32, day: u32) -> Option<String> {
        let name = MONTHS.get(month.checked_sub(1)? as usize)?;
        if !(1..=31).contains(&day) {
            return None;
        }
        let year = if year.len() == 2 {
            format!("20{year}")
        } else {
            year.to_string()
        };
        Some(format!("{name} {day}, {year}"))
    }
    static ISO: LazyLock<Regex> = LazyLock::new(|| re(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b"));
    static SLASHED: LazyLock<Regex> =
        LazyLock::new(|| re(r"\b(\d{1,2})/(\d{1,2})/(\d{4}|\d{2})\b"));
    let number = |c: &Captures, i: usize| c[i].parse::<u32>().unwrap_or(0);
    let text = ISO.replace_all(text, |c: &Captures| {
        said(&c[1], number(c, 2), number(c, 3)).unwrap_or_else(|| c[0].to_string())
    });
    SLASHED
        .replace_all(&text, |c: &Captures| {
            let (first, second) = (number(c, 1), number(c, 2));
            let (month, day) = if first > 12 {
                (second, first)
            } else {
                (first, second)
            };
            said(&c[3], month, day).unwrap_or_else(|| c[0].to_string())
        })
        .into_owned()
}

/// "3.2.1" as "3 point 2 point 1" and "v1.4" as "version 1 point 4". The model reads a lone
/// "3.5" fine but turns "3.2.1" into "3's 2. 1".
fn versions(text: &str) -> String {
    static VERSION: LazyLock<Regex> = LazyLock::new(|| re(r"\b([vV])?(\d+(?:\.\d+)+)\b"));
    VERSION
        .replace_all(text, |c: &Captures| {
            let number = &c[2];
            if c.get(1).is_none() && number.matches('.').count() < 2 {
                return c[0].to_string();
            }
            let said = number
                .split('.')
                .map(number_words)
                .collect::<Vec<_>>()
                .join(" point ");
            if c.get(1).is_some() {
                format!("version {said}")
            } else {
                said
            }
        })
        .into_owned()
}

/// 0-99 in words ("twelve", "forty-two"); larger numbers stay digits. The model reads a version
/// such as "0 point 1 point 7" as "Zero Poi Ampois set", but words come through.
fn number_words(digits: &str) -> String {
    const ONES: [&str; 20] = [
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
    ];
    const TENS: [&str; 10] = [
        "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
    ];
    match digits.parse::<usize>() {
        Ok(n) if n < 20 && !(digits.len() > 1 && digits.starts_with('0')) => ONES[n].to_string(),
        Ok(n) if (20..100).contains(&n) && n % 10 == 0 => TENS[n / 10].to_string(),
        Ok(n) if (20..100).contains(&n) => format!("{}-{}", TENS[n / 10], ONES[n % 10]),
        _ => digits.to_string(),
    }
}

/// Operators and symbols the voice drops or mangles, said as words.
fn symbols(text: &str) -> String {
    static OPERATOR: LazyLock<Regex> = LazyLock::new(|| re(r"[ \t]*(->|=>|→|=|\+|&|%)[ \t]*"));
    static SPACES: LazyLock<Regex> = LazyLock::new(|| re(r"[ \t]{2,}"));
    // A word put before sentence punctuation: "15 percent ." back to "15 percent."
    static BEFORE_STOP: LazyLock<Regex> = LazyLock::new(|| re(r"[ \t]+([.,;:!?]+)([ \t]|$)"));
    let said = OPERATOR.replace_all(text, |c: &Captures| {
        let word = match &c[1] {
            "->" | "=>" | "→" => "to",
            "=" => "equals",
            "+" => "plus",
            "&" => "and",
            _ => "percent",
        };
        format!(" {word} ")
    });
    let tidy: Vec<String> = said
        .lines()
        .map(|line| {
            let line = SPACES.replace_all(line, " ");
            BEFORE_STOP.replace_all(&line, "$1$2").trim().to_string()
        })
        .collect();
    tidy.join("\n")
}

#[cfg(test)]
mod tests {
    use super::to_speech;

    #[test]
    fn equations_are_said_in_words() {
        assert_eq!(
            to_speech("x = 5 and y = x + 2"),
            "x equals 5 and y equals x plus 2"
        );
    }

    #[test]
    fn links_are_said_as_their_site() {
        assert_eq!(
            to_speech("See https://www.github.com/RyderAsKing/winku/pulls?q=open for the list."),
            "See github dot com for the list."
        );
        assert_eq!(
            to_speech("It's at <http://localhost:5173/settings>."),
            "It's at localhost."
        );
    }

    #[test]
    fn paths_are_said_as_their_last_name() {
        assert_eq!(
            to_speech(r"Saved to C:\Users\me\Documents\report.pdf."),
            "Saved to report dot pdf."
        );
        assert_eq!(
            to_speech("Open ~/projects/winku/src/main.rs now"),
            "Open main dot rs now"
        );
        assert_eq!(
            to_speech(r"It's in C:\Users\me\Downloads\ and /var/log/ too"),
            "It's in Downloads and log too"
        );
        // A slash between words isn't a path.
        assert_eq!(to_speech("and/or yes/no"), "and/or yes/no");
    }

    #[test]
    fn versions_are_said_point_by_point() {
        assert_eq!(
            to_speech("Winku 0.1.7 is out, up from v0.1.6."),
            "Winku zero point one point seven is out, up from version zero point one point six."
        );
        assert_eq!(
            to_speech("Python v3.12 or 3.2.1"),
            "Python version three point twelve or three point two point one"
        );
        // Prices and plain decimals are the model's to read.
        assert_eq!(
            to_speech("It costs $4.50, about 3.5 times more."),
            "It costs $4.50, about 3.5 times more."
        );
    }

    #[test]
    fn dates_are_said_with_the_month_name() {
        assert_eq!(
            to_speech("Due 2026-11-15, moved from 2026-03-02."),
            "Due November 15, 2026, moved from March 2, 2026."
        );
        // Slashes read month first, unless the first number can't be a month.
        assert_eq!(to_speech("on 11/15/2026"), "on November 15, 2026");
        assert_eq!(to_speech("on 25/12/2026"), "on December 25, 2026");
        assert_eq!(to_speech("on 3/4/26"), "on March 4, 2026");
        // Not dates: a ratio, a range, a month that doesn't exist.
        assert_eq!(
            to_speech("1/2 cup, pages 10-20, 2026-13-01"),
            "1/2 cup, pages 10-20, 2026-13-01"
        );
    }

    #[test]
    fn symbols_the_voice_would_drop_are_said() {
        assert_eq!(
            to_speech("Up 15% -> 20% & stable; a=b+1, then x → y"),
            "Up 15 percent to 20 percent and stable; a equals b plus 1, then x to y"
        );
        assert_eq!(to_speech("2 + 2 = 4"), "2 plus 2 equals 4");
    }

    #[test]
    fn markdown_is_read_as_plain_sentences() {
        let reply = "## Steps\n- Run `cargo test` **first**.\n1. Read [the docs](https://tauri.app/start).\n> _Note_: done\n```sh\nrm -rf target\n```\n| a | b |\n|---|---|\nAll set.";
        assert_eq!(
            to_speech(reply),
            "Steps\nRun cargo test first.\nRead the docs.\nNote: done\nThe code is in the bar.\nThe table is in the bar.\nAll set."
        );
        // Asterisks and underscores inside words stay words.
        assert_eq!(to_speech("snake_case and 2*3"), "snake case and 2 times 3");
    }

    #[test]
    fn emoji_and_characters_the_voice_cannot_say_are_dropped() {
        assert_eq!(
            to_speech(
                "That\u{2019}s \u{201c}great\u{201d} \u{2014} done 🎉✅ in 5\u{2013}10 min\u{2026}"
            ),
            "That's \"great\", done in 5-10 min..."
        );
        assert_eq!(
            to_speech("Mail me@example.com, @here"),
            "Mail me at example dot com, here"
        );
        assert_eq!(to_speech("Café, naïve, 東京"), "Café, naïve, 東京");
    }
}
