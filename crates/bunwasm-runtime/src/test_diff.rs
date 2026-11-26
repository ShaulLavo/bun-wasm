//! `bun test`'s diff printer for coloured reports: Bun's own `print_diff_main` over its
//! `bun_text_diff` line and character diffs, so the highlighted runs match native Bun byte for
//! byte. The runtime's JavaScript port still renders uncoloured diffs.

use crate::data::Val;
use crate::natives::Table;
use crate::print_diff;

pub fn install(table: &mut Table) {
    // printDiff(not, received, expected, colors, agent): the text after the matcher's blank line.
    table.add("printDiff", |arguments| {
        let not = arguments.bool(0);
        let received = arguments.str(1)?;
        let expected = arguments.str(2)?;
        let config = print_diff::DiffConfig::default(arguments.bool(4), arguments.bool(3));
        let mut out = String::new();
        // Writing into a String cannot fail.
        let _ = print_diff::print_diff_main(
            not,
            received.as_bytes(),
            expected.as_bytes(),
            &mut out,
            &config,
        );
        Ok(Val::Str(out))
    });
}

#[cfg(test)]
mod tests {
    use crate::print_diff::{DiffConfig, print_diff_main};

    fn render(received: &str, expected: &str, colors: bool) -> String {
        let mut out = String::new();
        print_diff_main(
            false,
            received.as_bytes(),
            expected.as_bytes(),
            &mut out,
            &DiffConfig::default(false, colors),
        )
        .unwrap();
        out
    }

    #[test]
    fn single_line_values_highlight_the_changed_characters() {
        assert_eq!(
            render("1", "2", true),
            "Expected: \u{1b}[0m\u{1b}[32m2\u{1b}[0m\nReceived: \u{1b}[0m\u{1b}[31m1\u{1b}[0m"
        );
        assert_eq!(render("1", "2", false), "Expected: 2\nReceived: 1");
    }

    #[test]
    fn multi_line_values_mark_each_side() {
        let expected = "{\n  \"a\": 1,\n  \"c\": \"world\",\n}";
        let received = "{\n  \"a\": 1,\n  \"c\": \"hello\",\n}";
        assert_eq!(
            render(received, expected, true),
            "  \u{1b}[0m\u{1b}[2m{\u{1b}[0m\n  \u{1b}[0m\u{1b}[2m  \"a\": 1,\u{1b}[0m\n\
             \u{1b}[32m- \u{1b}[0m\u{1b}[32m  \"c\": \"\u{1b}[0m\u{1b}[32mworld\u{1b}[0m\u{1b}[32m\",\u{1b}[0m\n\
             \u{1b}[31m+ \u{1b}[0m\u{1b}[31m  \"c\": \"\u{1b}[0m\u{1b}[31mhello\u{1b}[0m\u{1b}[31m\",\u{1b}[0m\n\
             \u{20} \u{1b}[0m\u{1b}[2m}\u{1b}[0m\n\n\
             \u{1b}[32m- Expected  - 1\u{1b}[0m\n\u{1b}[31m+ Received  + 1\u{1b}[0m"
        );
    }
}
