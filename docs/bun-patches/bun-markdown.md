# Bun.markdown

| Local source | Classification | Upstream source |
| --- | --- | --- |
| `crates/bunwasm-build/src/markdown.rs` `html`, `ansi` | Adapted upstream implementation | Bun `src/runtime/api/MarkdownObject.rs` (`render_to_html`, `render_to_ansi`, error messages) at `29cd95a2f47461589f2ec47a978b4efccfcef9f4` |
| `crates/bunwasm-runtime/src/js/bun_markdown.ts` option parsing | Adapted upstream implementation | `MarkdownObject.rs` `parse_options` and the ANSI theme fields, same revision |
| `bun_md` dependency of `bunwasm-build` | Upstream crate, used unchanged | Bun `src/md`, already linked through `bun_bundler` |
| `Transpiler::markdown`, `MarkdownRequest`, `natives.rs` `markdown` | Original adapter | None |

`Bun.markdown.html(text, options)` and `Bun.markdown.ansi(text, theme)` render with Bun's own `bun_md` crate, which the bundler already links, so the guest grows only by the glue. The runtime reads the options in TypeScript the way `parse_options` does (the compound `autolinks` and `headings` options, then every boolean option by camelCase or snake_case name) and passes them to the bundler crate through the `Transpiler` trait, like `Bun.build`. A guest built without the bundler reports that `Bun.markdown` needs it.

`render(text, callbacks)` and `react(text, components)` call into JavaScript for every node and are not ported yet; they throw `ERR_NOT_SUPPORTED_IN_WASM`. `tests/fixtures/bun-probe-utils` compares HTML (tables, strikethrough, heading ids) and plain ANSI output with native Bun on every engine.
