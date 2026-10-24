## Lint and format commands

Class **Port**. Bun revision `9510e74152073d850a18758ca41114d8f214ffa6`.

`crates/bunwasm-tools/src/lint_command.rs` calls `src/lint/driver` for both commands.
Bun's native rule registry, parsers, semantic analysis, formatter, file discovery,
configuration resolution, fix application, and report formats use the vendored
implementations, with the WASI layout and docs-embedding adjustments listed below.
The adapter follows `src/runtime/cli/{lint_command,format_command}.rs` and
retains their help wording from `src/runtime/cli/mod.rs`. It parses
CLI options, loading `[lint]` and `[fmt]` defaults through the driver's bunfig
reader, applying flags over those defaults, then printing the driver's `Outcome`.
Parallel regions stay on the calling thread because WASI preview 1 has no threads.
`src/runtime/cli/typescript_libs.rs` is compiled directly from the pinned tree,
including its `typescript_libs.bin`, without copying or changing either file.

The command adapter also follows `src/runtime/cli/lint_command.rs::run_and_exit`
for the two directory changes: top-level `--cwd` first, then the tool's `--cwd`.
Its bunfig search adapts `src/bunfig/arguments.rs::Above` and
`load_config_above_for_tool`. Missing required sections keep the search needed,
a local lint section makes an unused formatter search optional, and either the
local rules or CLI can require `bun/format`. An unusable optional ancestor ends
the search. Named and required configs retain their diagnostics.

`crates/bunwasm-lint-native/build.rs` extracts the `RegularExpression` struct and
compile/execute/deinit bindings from `src/jsc/bindings/RegularExpression.cpp`.
It omits the BunString entry points and replaces the runtime headers with JSC's
headers. It also compiles `src/jsc/bindings/NumberConversions.cpp`, replacing
`root.h` with `config.h` and removing the Bun-specific export annotation, to
retain Bun's fixed, precision, and exponential number formatting. The original
initialization shim initializes WTF and the options read by Yarr's bytecode
interpreter, without starting the VM. The build reads those option names from
WebKit's Yarr sources and their default values from `runtime/OptionsList.h`.
Calling the full options initializer also retains the VM through its validation
and notification code, so this interpreter-only entry point avoids it.
Only `dist/bun-tools.wasm` links these bindings against the prebuilt WebKit
WTF/ICU archives. The tools build compiles WebKit's Yarr sources and its generated
Unicode canonicalization table as separate objects, using the prebuilt engine's
compiler flags and headers. It does not link `libJavaScriptCore.a`. Pulling Yarr
from that unified archive also retained unrelated VM code and ICU data. This
change removes that archive dependency without changing Yarr's source.
WebKit revision is `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`. Direct sources are
`Source/JavaScriptCore/yarr/{YarrPattern,YarrInterpreter,YarrCanonicalizeUCS2,YarrUnicodeProperties,YarrErrorCode,YarrFlags}.cpp`.
`YarrCanonicalizeUnicode.cpp` comes from the same build's generated sources.
Default engines do not link the tools or their native dependencies. This keeps
Bun's Yarr regex semantics for native lint rules. The build flag selection follows `crates/bunwasm-jsc/build.rs`. `zstd-sys` supplies the zstd
symbols used to read Bun's bundled TypeScript libraries and rule data.

JavaScript lint plugins require `src/jsc/bindings/Lint*.cpp`, whose node, token,
scope, and rule-report objects depend on Bun's JSC runtime. They currently produce
an explicit unsupported-binding error. Native rules remain Bun's own code.
Git-based file selection requires an external git executable, which the guest's
subprocess ABI does not provide. Canary-only conformance command flags are not
part of the release CLI adapter.

The host selects the tools artifact before instantiating a lint or format command.
`crates/bunwasm-cli/src/tool_args.rs` retains the CLI command-prefix parser for
both the native host and tools entry point. `web/src/tool-command.ts` mirrors that
small selection rule for browser and Node hosts. Eval source, script arguments,
and build/test arguments cannot select a tool. The tools process uses the same
pid, streams, cwd, signal state, filesystem identity and child admission as the
command it replaces. This is an original host adapter. It adds no forwarding
child or separate process-capacity limit.

The single tools artifact has no JavaScript engine. Config evaluation self-spawns
through the generic `runtime_proc` ABI into the selected engine executable. Browser hosts download and
compile tools on the first tool command, reuse the compiled module within the
page, and use the fingerprinted engine cache across page loads. The cached
response header is the single publication state, without a separate localStorage
marker. The site ships a
gzip artifact and build hash in both sandbox and playground. The Bun service
worker forwards tools requests. The runner verifies their manifest fingerprint
before compilation and publishes only verified bytes to its startup cache.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Lint and format command adapters](#lint-and-format-commands) | Port | Compile Bun's native linter, formatter, CLI parsers, and Yarr regex bindings for WASI. |
