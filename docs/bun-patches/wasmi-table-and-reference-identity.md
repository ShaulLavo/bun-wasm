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

Wasmi retains Store allocations until process teardown. Externref roots,
callback registrations, callable wrappers, and external memory bytes live for
that same process lifetime. The split driver deliberately retains the engine
and rooted internal object; it provides no VM, Store, or session reuse path.
Overwriting a table entry does not reclaim its former JS root. This is an
explicit limitation, not a per-entry GC or memory-performance guarantee.
Retained tables and callables continue to work after the exporting JS instance
is collected.

`wasm.memorySpan` resolves a memory resource identity in the current Store and
returns its pointer, byte length, and growth generation. JavaScript supplies a
resource identity, never a pointer. The engine value native validates integer
fields, page-sized length, non-null origin, overflow, and guest linear-memory
bounds before creating an external ArrayBuffer over those bytes. Wasmi owns
the allocation; the JSC and QuickJS buffer deallocators do not free it. Both
engine adapters mark the buffer as WebAssembly memory and refuse user transfer.
Shared Wasm memories (`shared: true`) remain unsupported; this protocol does
not supply cross-agent synchronization.

Tables and memories use weak wrapper interning. Memory state is also weakly
indexed by backend resource. A weak map from each current buffer to its state
keeps a retained buffer or view associated with its resource after wrapper
collection. Growth removes the old buffer's anchor before detaching it. When
both wrapper and current buffer are dead, that state can collect; detached old
buffers do not retain later generations. The Store still owns the bytes.

Calls and resumptions refresh memory generations in `finally`, including
suspension, callback exceptions, and reentry. The import callback therefore
sees current views, and resuming it refreshes again before returning to user
code. Instantiation and successful explicit growth also refresh the views.
An unchanged generation preserves buffer identity without copying bytes.
Every successful growth, including zero pages, advances the generation and
detaches the previous buffer and all its views before exposing a replacement.
Failed growth leaves the generation and current buffer intact. This also
covers indirect calls that grow another instance's memory.

## Verification

Run `source env.sh` and `bun test scripts/wasm-tables.test.ts`. The test creates
an isolated offline Cargo crate containing actual production `wasm.rs`,
`data.rs`, and the native registry declaration. Its native process exchanges
plain data with the real factory on Node, without a mock table or callable. This
out-of-process harness mirrors memory bytes through test-only bridge calls;
it does not exercise the engine's in-place buffer adapter. The actual engine
pair fixtures provide that separate evidence.
The two reference tests embed the repository-owned `tests/wasm-tables/table.wasm`
compiled with `wasm-tools parse tests/wasm-tables/table.wat -o
tests/wasm-tables/table.wasm`. The original 395-byte source SHA-256 is
`d849070911fb1b6516ea32fa76dbcbeaa1461055fbb201c2e3eea41059879265`;
the 150-byte binary SHA-256 is
`e0a25470bbc2562a1e348886754f4627e05d1ccd83ab604d9020e1b68842bd74`.
They need no fixture environment
variables under ordinary Cargo test discovery. The runner removes both
`WASM_TABLE_SCRATCH` and `TABLE_FIXTURES` from the Rust test process.
It runs the existing Rust memory controls, real identity/Store-drop controls,
JS GC and retained-callable controls, duplicate-signature imports, reentry,
exceptions, and indirect cross-instance memory growth. Review regressions also
cover buffer-only and wrapper-only retention, both-dead collection, old-buffer
anchor removal, re-exported memory views, immutable instance exports, table
argument presence, element string conversion, and descriptor getter counts. The adjacent memory suite
loads the actual TypeScript factory with the established Bun.Transpiler pattern
and invokes actual Bun GC without a skipped lifetime assertion. Its unique checks
manifest includes it in runtime and local-runtime discovery.

The optional `WASM_TABLE_SWC` directory must contain exact cached `wasm.js`
and `wasm_bg.wasm` from `@next/swc-wasm-nodejs@16.4.3`. The retained report
records their hashes and a successful unmodified backend transform using the
original ES2022 probe options. No application, browser, production artifact,
or engine-integration acceptance follows from this source/native result.

## Engine buffer adapters

The original JSC adapters in `crates/bunwasm-engine-jsc/src/vm.rs` and
`crates/bunwasm-jsc/{cpp/helpers.cpp,src/sys.rs}` call WebKit's
`ArrayBuffer::createFromBytes`, `makeWasmMemory`, `isWasmMemory`, and `detach`.
Their upstream reference is Bun's WebKit fork at
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb`, under
`Source/JavaScriptCore/runtime/ArrayBuffer.{h,cpp}` and `JSArrayBuffer.h`.
These are original host-feature adapters, not copied WebKit implementations.
They view the Store-owned bytes with a deallocator that does not free them.
The QuickJS adapter and its local buffer flag/helper patch are classified in
[the QuickJS record](quickjs.md).
