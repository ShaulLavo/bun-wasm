## HTMLRewriter

Private handler registrations and synchronous output chunks append with a
captured `Object.defineProperty`, not indexed assignment through `push`.
An indexed accessor on `Array.prototype` therefore cannot intercept them.
This is an original storage fix, compared against Bun's
`test/js/workerd/html-rewriter-leak.test.ts` at pin
`9510e74152073d850a18758ca41114d8f214ffa6`.
The registration wire format serializes only primitive strings through
`JSON.stringify`. QuickJS-ng's object serialization pushes objects into a
private JS array and invokes inherited indexed setters. The HTML adapter now
joins its fixed-shape records directly, without changing the engine or #113's
own-property append fix.

The original lifetime adapter now observes the returned native promise without
retaining it in the registry's held callback. Collection rejects a separate
waiter with the abandonment error. Cancellation settles that waiter, including
when the handler cancels before returning its promise. This releases the
suspended input graph before the handler settles. Thenable fulfillment still
discards its value, and rejection values pass through unchanged. Promise handlers
read `then` once without a native brand or prototype-chain query. A custom callable
keeps its original receiver, a throwing getter keeps its exact error, and a non-callable
`then` does not park the rewrite. An object whose selected method equals the
captured `Promise.prototype.then` is observed directly. That intrinsic validates
its receiver without a prototype query. Other thenables keep the
value-discarding wrapper. The captured method attaches the reactions, preserving
constructor and species access. A synchronous attachment error unregisters and
settles the waiter before it escapes. These are original adapter changes, not
changes to global Promise machinery. The comparison
source is Bun's unchanged `test/js/workerd/html-rewriter-leak.test.ts` and
`src/runtime/api/html_rewriter.rs` at revision
`d71508d31edf06765c12adf0df137ef531539f68`. No implementation was copied.
`bun:internal-for-testing.htmlRewriterCount()` reports the actual Rust parser
session table length; it does not synthesize heap statistics.

Class **Host feature**, **original adapters** in `crates/bunwasm-runtime/src/html_rewriter.rs`,
`src/js/html_rewriter.ts`, the native table and global registry.
The runtime links the unchanged `vendor/bun/vendor/lolhtml` Rust crate at Bun revision
`cd95fa7a13b3f13be73e512b38ec111c1c228084`. The vendored crate is lol-html 2.7.2,
including Bun's token suspension support. No vendor file changes.

Each transform owns a parser session. Content handlers suspend the parser and return a
plain-data event. TypeScript invokes the registered handler, waits for its promise for a
Response input, then resumes the parser. String and buffer inputs remain synchronous and
reject handlers that need asynchronous work. Response inputs consume the source reader
incrementally, keep the native-consumer reader lock after completion, forward cancellation
and preserve handler rejection values. Tokens and
attribute iterators detach when their handler ends. The wrapper is original bun-wasm code.
Bun's corresponding implementation, `src/runtime/api/html_rewriter.rs`, depends on Bun's
JSC-specific generated classes and stream sinks and cannot run through the builtin loader.

`third_party/licenses/lol-html-LICENSE` is copied unchanged from that vendored crate.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [HTMLRewriter adapters and lol-html linkage](#htmlrewriter) | Host feature | Original parser sessions, cancellable async handler waits, observable Promise handlers, private indexed storage and streaming wrappers on all engines. |
| [`third_party/licenses/lol-html-LICENSE`](#htmlrewriter) | Port | Retain the vendored parser's BSD license for wasm distribution. |

[Ledger scope and pinned revisions](scope.md).
