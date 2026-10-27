# Wasmi table and function identity

| Change | Class | Reason |
| --- | --- | --- |
| Public equality on Wasmi `Table` and `Func` | Port | Preserve JavaScript identity for aliases, imported resources, and table-held functions. |
| Runtime table/reference bridge | Host feature | Expose real interpreter resources through the existing plain-data native boundary. |

## Upstream API extension

`third_party/wasmi` is the published Wasmi 0.46.0 crate from
`wasmi-labs/wasmi`, upstream `crates/wasmi` revision
`50ac76771d631f642e8c4c61bf44c99546024461`. Its cached `.cargo_vcs_info.json`
and the existing [memory record](wasmi-memory-identity-and-growth.md) identify
that revision. `crate-source wasmi --version 0.46.0` locates this exact release.

This change adds derived public `PartialEq` and `Eq` to upstream
`src/table/mod.rs::Table` and `src/func/mod.rs::Func`. Both compare the existing
`Stored` handle, which includes the store identity and entity index. The API
matches this fork's existing `Memory` equality. Private `Table::eq` and its
callers stay intact; its note now describes the public equality accurately.
No layout, allocation, interpreter algorithm, pointer conversion, raw-bit
identity, or Debug representation changes. Parent cleared these exact hunks
before editing them.

The regression compares aliases, distinct instances, and distinct stores.
Table-returned functions and exported aliases must intern to one callable.

## Original adapter

`crates/bunwasm-runtime/src/wasm.rs`, `src/js/webassembly.ts`, its declarations,
and `tests/wasm-tables/` are original bun-wasm code. The three tiny table,
import-table, and externref fixtures were retained from the October 26
bun-wasm source investigation at `585afc981994ee8db4da1de3c963fb8303f08a29`.
They are original regression programs, with no copied upstream implementation.
The existing memory adapter was converted from JavaScript to TypeScript.
No Bun, Node, WebKit, or SWC implementation is copied into this adapter.

The bridge interns real Wasmi tables/functions and carries tagged reference
handles across the existing native data contract. JS values stay in a
runtime-local root map, preserving arbitrary object, function, symbol,
undefined, null, and cyclic identity. Callbacks have one registration per
import binding, including signatures and owner identity. Positional
`Instance::new` supports repeated import names with different signatures.
Wasm and direct host suspensions share the runtime call registry.

## Lifetime and synchronization policy

Wasmi retains Store allocations until teardown. Externref roots, callback
registrations, and callable wrappers conservatively live for that same
runtime lifetime. Overwriting a table entry does not reclaim its former JS
root. This is an explicit limitation; no per-entry GC or memory-performance
claim is made. The root map has no external owner after its factory realm is
released. Tables and memories use weak wrapper interning. Retained tables and
callables continue to work after the exporting JS instance is collected.

Every Wasm call/resumption flushes all live memory wrappers before execution
and refreshes them afterward, including suspension, callback exceptions, and
reentry. This covers indirect calls into other instances. Successful growth
still detaches prior buffers. This policy makes no performance claim.

## Verification

Run `source env.sh` and `bun test scripts/wasm-tables.test.ts`. The test creates
an isolated offline Cargo crate containing actual production `wasm.rs`,
`data.rs`, and the native registry declaration. Its native process exchanges
plain data with the real factory on Node, without a mock table or callable.
It runs the existing Rust memory controls, real identity/Store-drop controls,
JS GC and retained-callable controls, duplicate-signature imports, reentry,
exceptions, and indirect cross-instance memory growth. Its unique checks
manifest includes it in runtime and local-runtime discovery.

The optional `WASM_TABLE_SWC` directory must contain exact cached `wasm.js`
and `wasm_bg.wasm` from `@next/swc-wasm-nodejs@16.4.3`. The retained report
records their hashes and a successful unmodified backend transform using the
original ES2022 probe options. No application, browser, production artifact,
or engine-integration acceptance follows from this source/native result.
