# BUN_OPTIONS

| Local source | Classification | Upstream source |
| --- | --- | --- |
| `crates/bunwasm-cli/src/main.rs`, `bun_options`, `option_argument`, `plain_argument` | Adapted upstream implementation | Bun `src/bun_core/util.rs` (`append_options_env` and the `argv_view_init` splice) at `9510e74152073d850a18758ca41114d8f214ffa6`, SHA-256 `8e09f7413cd307db9087139806efd2fa28742f581ec8a2f250665005bb7f0a5b` |

Bun reads `BUN_OPTIONS` as extra command-line arguments placed right after `argv[0]`, before what was typed, for every command. The CLI now does the same before it parses, so `BUN_OPTIONS=--disable-warning=DEP2` reaches `process.execArgv` and the warning printer ([process warnings](process-warnings.md)), and a worker guest, which inherits the environment, sees it too.

The tokenizer keeps Bun's rules: an argument starting with `--` ends at whitespace or `=`; `--flag=value` runs to the next whitespace; a quoted value after `=` or after whitespace is kept with its quotes as part of that argument; `--flag value` leaves `value` as its own argument. Other words drop their quotes and honor backslash escapes. The port splits one function into three and works on the UTF-8 bytes of the variable; a non-UTF-8 value is ignored, as `std::env::var` reports it.

`bun_options_split_like_bun` in the CLI's unit tests covers each rule; the `--flag value` and quoted bare-word cases were checked against native Bun 1.4.4.
