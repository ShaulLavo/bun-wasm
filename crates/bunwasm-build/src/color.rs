//! `Bun.color` over Bun's CSS color parser, adapted from `src/css_jsc/color_js.rs`
//! (docs/bun-patches/bun-color.md). The runtime reads JavaScript inputs (numbers, arrays,
//! `{ r, g, b, a }`) into RGBA; this module parses CSS text and formats the result.

use bun_alloc::Arena;
use bun_ast::symbol::Map as SymbolMap;
use bun_css as css;
use bun_css::CssColor;
use bun_css::values::color::{HSL, LAB, RGBA, SRGB};

pub enum ColorInput<'a> {
    Css(&'a [u8]),
    Rgba([u8; 4]),
}

pub enum ColorOutput {
    /// The input is not a color.
    Null,
    Text(String),
    Number(f64),
    Array(Vec<f64>),
    /// `(key, value)` in Bun's property order.
    Object(Vec<(&'static str, f64)>),
}

#[derive(Copy, Clone, PartialEq, Eq)]
enum Format {
    Empty,
    Ansi16,
    Ansi16m,
    Ansi256,
    Css,
    Hex,
    HexUpper,
    Hsl,
    Lab,
    Number,
    Rgb,
    Rgba,
    RgbArray,
    RgbaArray,
    RgbObject,
    RgbaObject,
}

/// Bun's `OUTPUT_COLOR_FORMAT_MAP`.
pub const FORMATS: &[&str] = &[
    "ansi",
    "[r,g,b,a]",
    "[rgb]",
    "[rgba]",
    "{r,g,b}",
    "{rgb}",
    "{rgba}",
    "ansi_256",
    "ansi-256",
    "ansi_16",
    "ansi-16",
    "ansi_16m",
    "ansi-16m",
    "ansi-24bit",
    "ansi-truecolor",
    "ansi256",
    "css",
    "hex",
    "HEX",
    "hsl",
    "lab",
    "number",
    "rgb",
    "rgba",
];

fn format_named(name: &str) -> Option<Format> {
    use bun_core::output::{ColorDepth, Source};
    Some(match name {
        // `ansi` follows the terminal, as in Bun; no color support yields an empty string.
        "ansi" => match Source::color_depth() {
            ColorDepth::None => return Some(Format::Empty),
            ColorDepth::C16 => Format::Ansi16,
            ColorDepth::C256 => Format::Ansi256,
            ColorDepth::C16m => Format::Ansi16m,
        },
        "[r,g,b,a]" | "[rgba]" => Format::RgbaArray,
        "[rgb]" => Format::RgbArray,
        "{r,g,b}" | "{rgb}" => Format::RgbObject,
        "{rgba}" => Format::RgbaObject,
        "ansi_256" | "ansi-256" | "ansi256" => Format::Ansi256,
        "ansi_16" | "ansi-16" => Format::Ansi16,
        "ansi_16m" | "ansi-16m" | "ansi-24bit" | "ansi-truecolor" => Format::Ansi16m,
        "css" => Format::Css,
        "hex" => Format::Hex,
        "HEX" => Format::HexUpper,
        "hsl" => Format::Hsl,
        "lab" => Format::Lab,
        "number" => Format::Number,
        "rgb" => Format::Rgb,
        "rgba" => Format::Rgba,
        _ => return None,
    })
}

pub fn color(input: ColorInput<'_>, format: &str) -> Result<ColorOutput, String> {
    let format = format_named(format)
        .ok_or_else(|| format!("format must be one of '{}'", FORMATS.join("', '")))?;
    let parsed = match input {
        ColorInput::Rgba([red, green, blue, alpha]) => CssColor::Rgba(RGBA {
            alpha,
            red,
            green,
            blue,
        }),
        ColorInput::Css(text) => {
            let arena = Arena::new();
            let mut parser_input = css::ParserInput::new(text, &arena);
            let mut parser = css::Parser::new(
                &mut parser_input,
                None,
                css::css_parser::ParserOpts::default(),
                None,
            );
            match CssColor::parse(&mut parser) {
                Ok(color) => color,
                // Bun returns null for anything that is not a color.
                Err(_) => return Ok(ColorOutput::Null),
            }
        }
    };
    Ok(formatted(&parsed, format).unwrap_or_else(|| css_text(&parsed)))
}

/// `None` falls back to the CSS printer, as Bun does for colors it cannot convert.
fn formatted(color: &CssColor, format: Format) -> Option<ColorOutput> {
    match format {
        Format::Css => None,
        Format::Empty => Some(ColorOutput::Text(String::new())),
        Format::Hsl => hsl(color),
        Format::Lab => lab(color),
        _ => srgb(color).map(|srgb| rgba_output(srgb.into_rgba(), format)),
    }
}

fn srgb(color: &CssColor) -> Option<SRGB> {
    Some(match color {
        CssColor::Float(float) => match &**float {
            css::FloatColor::Rgb(rgb) => *rgb,
            other => other.into_srgb(),
        },
        CssColor::Rgba(rgba) => rgba.into_srgb(),
        CssColor::Lab(lab) => lab.into_srgb(),
        _ => return None,
    })
}

fn rgba_output(rgba: RGBA, format: Format) -> ColorOutput {
    let (r, g, b) = (rgba.red, rgba.green, rgba.blue);
    match format {
        Format::RgbaObject => ColorOutput::Object(vec![
            ("r", f64::from(r)),
            ("g", f64::from(g)),
            ("b", f64::from(b)),
            ("a", f64::from(rgba.alpha_f32())),
        ]),
        Format::RgbObject => ColorOutput::Object(vec![
            ("r", f64::from(r)),
            ("g", f64::from(g)),
            ("b", f64::from(b)),
        ]),
        Format::RgbArray => ColorOutput::Array(vec![f64::from(r), f64::from(g), f64::from(b)]),
        Format::RgbaArray => ColorOutput::Array(vec![
            f64::from(r),
            f64::from(g),
            f64::from(b),
            f64::from(rgba.alpha),
        ]),
        Format::Number => ColorOutput::Number(f64::from(
            (u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b),
        )),
        Format::Hex => ColorOutput::Text(format!("#{r:02x}{g:02x}{b:02x}")),
        Format::HexUpper => ColorOutput::Text(format!("#{r:02X}{g:02X}{b:02X}")),
        Format::Rgb => ColorOutput::Text(format!("rgb({r}, {g}, {b})")),
        Format::Rgba => ColorOutput::Text(format!("rgba({r}, {g}, {b}, {})", rgba.alpha_f32())),
        Format::Ansi16 => {
            // 16-color SGR: 30..=37 for the first eight, 90..=97 for their bright variants.
            let index = ansi256::get16(u32::from(r), u32::from(g), u32::from(b));
            let sgr = if index < 8 { 30 + index } else { 82 + index };
            ColorOutput::Text(format!("\x1b[{sgr}m"))
        }
        Format::Ansi16m => ColorOutput::Text(format!("\x1b[38;2;{r};{g};{b}m")),
        Format::Ansi256 => {
            let mut buf: ansi256::Buffer = [0u8; 24];
            ColorOutput::Text(
                String::from_utf8_lossy(ansi256::from(r, g, b, &mut buf)).into_owned(),
            )
        }
        Format::Css | Format::Empty | Format::Hsl | Format::Lab => {
            unreachable!("handled by formatted()")
        }
    }
}

fn hsl(color: &CssColor) -> Option<ColorOutput> {
    let hsl: HSL = match color {
        CssColor::Float(float) => match &**float {
            css::FloatColor::Hsl(hsl) => *hsl,
            other => other.into_hsl(),
        },
        CssColor::Rgba(rgba) => rgba.into_hsl(),
        CssColor::Lab(lab) => lab.into_hsl(),
        _ => return None,
    };
    // Saturation and lightness are stored as 0..1 but hsl() takes percentages.
    Some(ColorOutput::Text(format!(
        "hsl({}, {}%, {}%)",
        zero_if_none(hsl.h),
        zero_if_none(hsl.s) * 100.0,
        zero_if_none(hsl.l) * 100.0
    )))
}

fn lab(color: &CssColor) -> Option<ColorOutput> {
    let lab: LAB = match color {
        CssColor::Float(float) => float.into_lab(),
        CssColor::Lab(lab) => match &**lab {
            css::LabColor::Lab(lab) => *lab,
            other => other.into_lab(),
        },
        CssColor::Rgba(rgba) => rgba.into_lab(),
        _ => return None,
    };
    Some(ColorOutput::Text(format!(
        "lab({}% {} {})",
        zero_if_none(lab.l) * 100.0,
        zero_if_none(lab.a),
        zero_if_none(lab.b)
    )))
}

fn css_text(color: &CssColor) -> ColorOutput {
    let arena = Arena::new();
    let mut dest: Vec<u8> = Vec::new();
    let symbols = SymbolMap::init_list(Default::default());
    let mut printer = css::Printer::new(
        &arena,
        bun_alloc::ArenaVec::<u8>::new_in(&arena),
        &mut dest,
        &css::PrinterOptions::default(),
        None,
        None,
        &symbols,
    );
    if color.to_css(&mut printer).is_err() {
        return ColorOutput::Null;
    }
    drop(printer);
    ColorOutput::Text(String::from_utf8_lossy(&dest).into_owned())
}

/// A missing color component (CSS Color 4's `none`, or the hue of an achromatic color) is
/// stored as NaN and behaves as zero outside of interpolation.
fn zero_if_none(component: f32) -> f32 {
    if component.is_nan() { 0.0 } else { component }
}

// https://github.com/tmux/tmux/blob/dae2868d1227b95fd076fb4a5efa6256c7245943/colour.c#L44-L55
mod ansi256 {
    use std::io::Write as _;

    const Q2C: [u32; 6] = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];

    fn sqdist(r_: u32, g_: u32, b_: u32, r: u32, g: u32, b: u32) -> u32 {
        (r_.wrapping_sub(r))
            .wrapping_mul(r_.wrapping_sub(r))
            .wrapping_add((g_.wrapping_sub(g)).wrapping_mul(g_.wrapping_sub(g)))
            .wrapping_add((b_.wrapping_sub(b)).wrapping_mul(b_.wrapping_sub(b)))
    }

    fn to_6_cube(v: u32) -> u32 {
        if v < 48 {
            return 0;
        }
        if v < 114 {
            return 1;
        }
        (v - 35) / 40
    }

    fn get(r: u32, g: u32, b: u32) -> u32 {
        let qr = to_6_cube(r);
        let cr = Q2C[qr as usize];
        let qg = to_6_cube(g);
        let cg = Q2C[qg as usize];
        let qb = to_6_cube(b);
        let cb = Q2C[qb as usize];
        let cube = 16u32
            .wrapping_add(36u32.wrapping_mul(qr))
            .wrapping_add(6u32.wrapping_mul(qg))
            .wrapping_add(qb);
        if cr == r && cg == g && cb == b {
            return cube;
        }
        let grey_avg = (r.wrapping_add(g).wrapping_add(b)) / 3;
        // tmux does this in signed int, where (2 - 3) / 10 truncates to 0.
        let grey_idx = if grey_avg > 238 {
            23
        } else {
            grey_avg.saturating_sub(3) / 10
        };
        let grey = 8u32.wrapping_add(10u32.wrapping_mul(grey_idx));
        let d = sqdist(cr, cg, cb, r, g, b);
        if sqdist(grey, grey, grey, r, g, b) < d {
            232u32.wrapping_add(grey_idx)
        } else {
            cube
        }
    }

    const TABLE_256: [u8; 256] = [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 4, 4, 4, 12, 12, 2, 6, 4, 4, 12,
        12, 2, 2, 6, 4, 12, 12, 2, 2, 2, 6, 12, 12, 10, 10, 10, 10, 14, 12, 10, 10, 10, 10, 10, 14,
        1, 5, 4, 4, 12, 12, 3, 8, 4, 4, 12, 12, 2, 2, 6, 4, 12, 12, 2, 2, 2, 6, 12, 12, 10, 10, 10,
        10, 14, 12, 10, 10, 10, 10, 10, 14, 1, 1, 5, 4, 12, 12, 1, 1, 5, 4, 12, 12, 3, 3, 8, 4, 12,
        12, 2, 2, 2, 6, 12, 12, 10, 10, 10, 10, 14, 12, 10, 10, 10, 10, 10, 14, 1, 1, 1, 5, 12, 12,
        1, 1, 1, 5, 12, 12, 1, 1, 1, 5, 12, 12, 3, 3, 3, 7, 12, 12, 10, 10, 10, 10, 14, 12, 10, 10,
        10, 10, 10, 14, 9, 9, 9, 9, 13, 12, 9, 9, 9, 9, 13, 12, 9, 9, 9, 9, 13, 12, 9, 9, 9, 9, 13,
        12, 11, 11, 11, 11, 7, 12, 10, 10, 10, 10, 10, 14, 9, 9, 9, 9, 9, 13, 9, 9, 9, 9, 9, 13, 9,
        9, 9, 9, 9, 13, 9, 9, 9, 9, 9, 13, 9, 9, 9, 9, 9, 13, 11, 11, 11, 11, 11, 15, 0, 0, 0, 0,
        0, 0, 8, 8, 8, 8, 8, 8, 7, 7, 7, 7, 7, 7, 15, 15, 15, 15, 15, 15,
    ];

    pub(super) fn get16(r: u32, g: u32, b: u32) -> u8 {
        TABLE_256[(get(r, g, b) & 0xff) as usize]
    }

    pub(super) type Buffer = [u8; 24];

    pub(super) fn from(red: u8, green: u8, blue: u8, buf: &mut Buffer) -> &[u8] {
        let val = get(u32::from(red), u32::from(green), u32::from(blue));
        buf[..7].copy_from_slice(b"\x1b[38;5;");
        let extra_len = {
            let mut cursor = &mut buf[7..];
            let before = cursor.len();
            write!(cursor, "{val}m").expect("24 bytes hold any index");
            before - cursor.len()
        };
        &buf[..7 + extra_len]
    }
}
