//! `Bun.markdown.html` and `Bun.markdown.ansi` over Bun's `bun_md`, following
//! `src/runtime/api/MarkdownObject.rs` (docs/bun-patches/bun-markdown.md). The runtime
//! parses the JavaScript options and passes flat values here.

use bun_md::parser::{MAX_INPUT_LEN, ParserError};
use bun_md::root as md;

/// `options` are `(snake_case name, value)` pairs of `md::Options` bool fields.
pub fn html(text: &[u8], options: &[(String, bool)]) -> Result<Vec<u8>, String> {
    let mut parsed = md::Options::default();
    for (name, value) in options {
        let setter = md::Options::BOOL_FIELD_SETTERS
            .iter()
            .find(|(snake, _, _)| snake == name);
        if let Some((_, _, set)) = setter {
            set(&mut parsed, *value);
        }
    }
    md::render_to_html_with_options(text, parsed)
        .map(Vec::from)
        .map_err(message)
}

/// The theme fields Bun reads from `Bun.markdown.ansi(text, theme)`; `None` keeps Bun's default.
pub struct AnsiOptions {
    pub colors: Option<bool>,
    pub hyperlinks: Option<bool>,
    pub kitty_graphics: Option<bool>,
    pub light: Option<bool>,
    pub columns: Option<u16>,
}

pub fn ansi(text: &[u8], options: &AnsiOptions) -> Result<Vec<u8>, String> {
    let theme = md::AnsiTheme {
        colors: options.colors.unwrap_or(true),
        hyperlinks: options.hyperlinks.unwrap_or(false),
        kitty_graphics: options.kitty_graphics.unwrap_or(false),
        light: options.light.unwrap_or_else(md::detect_light_background),
        columns: options.columns.unwrap_or(80),
        remote_image_paths: None,
        image_base_dir: None,
    };
    match md::render_to_ansi(text, md::Options::TERMINAL, theme) {
        Ok(Some(out)) => Ok(Vec::from(out)),
        Ok(None) => Err("Out of memory".to_owned()),
        Err(err) => Err(message(err)),
    }
}

fn message(err: ParserError) -> String {
    use ParserError as E;
    match err {
        E::OutOfMemory | E::JSError => "Out of memory".to_owned(),
        E::StackOverflow => "Maximum call stack size exceeded".to_owned(),
        E::InputTooLarge => format!(
            "The value of \"input.byteLength\" is out of range. It must be <= {}",
            MAX_INPUT_LEN
        ),
        E::TooManyBlocks => {
            "markdown input requires more block metadata than the parser can address (4 GiB)"
                .to_owned()
        }
    }
}
