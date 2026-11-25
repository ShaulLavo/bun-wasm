# Bun.color

| Local source | Classification | Upstream source |
| --- | --- | --- |
| `crates/bunwasm-build/src/color.rs` parsing, conversion, output formats and `ansi256` | Adapted upstream implementation | Bun `src/css_jsc/color_js.rs` (`js_function_color`, `OUTPUT_COLOR_FORMAT_MAP`, `ansi256`, `zero_if_none`) at `29cd95a2f47461589f2ec47a978b4efccfcef9f4` |
| `crates/bunwasm-runtime/src/js/bun_color.ts` input handling and argument errors | Adapted upstream implementation | `color_js.rs` (`color_int_from_js`, number, array and object inputs, format validation), same revision |
| `bun_css` dependency of `bunwasm-build` | Upstream crate, used unchanged | Bun `src/css`, already linked through `bun_bundler` |
| `Transpiler::color`, `ColorInput`, `ColorValue`, `natives.rs` `color` | Original adapter | None |

`Bun.color(input, format)` parses CSS colors with Bun's own `bun_css` parser and formats them exactly as `color_js.rs` does: `css`, `hex`/`HEX`, `rgb`/`rgba`, `hsl`, `lab`, `number`, the array and object forms, and the ANSI escapes (`ansi-16`, `ansi-256`, `ansi-16m`, and `ansi`, which follows Bun's terminal color depth from `bun_core`). The JavaScript side reads numbers, arrays and `{ r, g, b, a }` objects into RGBA the way Bun does (channels truncated and clamped to 0 to 255, alpha only above 24 bits), and the JSValue builders become a small result enum crossing the `Transpiler` trait. Text that is not a color returns `null`, as in Bun.

`tests/fixtures/bun-probe-utils` compares eleven inputs and formats with native Bun on every engine.
