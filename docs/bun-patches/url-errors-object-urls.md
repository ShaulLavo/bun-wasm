## URL errors and object URLs

Class **Host feature**, original adapters. No upstream implementation is copied.
The comparison sources are Bun `src/jsc/bindings/webcore/JSDOMURL.cpp`,
`src/runtime/webcore/ObjectURLRegistry.rs`, `src/jsc/modules/NodeBufferModule.h`, and the unchanged
`test/js/web/url/url.test.ts` at
`9510e74152073d850a18758ca41114d8f214ffa6`. Native Bun 1.4.4
`38afee6c8` supplies the behavior oracle; Node 26.12.1 confirms Blob resolution
and revocation behavior where the APIs agree.

`url_errors.ts` supplies URL argument errors and string conversion. The existing
`web.js` URL constructor, parser methods and href setter use it. Missing arguments
throw `ERR_MISSING_ARGS`; invalid URLs carry the converted input and an optional
converted base. Conversion runs once per user value and preserves thrown errors.
Symbol conversion throws even from `URL.parse`, whose null result represents a
parse failure. `URL.canParse.length` and `URL.parse.length` are one.

`object_urls.ts` owns one private registry per guest. `web.js` installs its standard
URL methods before user code runs, and `buffer.js` exports its resolver through the
existing module factory. The registry validates Blob state through the captured
intrinsic type getter. It snapshots the bytes at creation and returns a fresh Blob
on each resolution. File snapshots preserve name and lastModified. Revocation
removes the registry entry while already resolved Blobs remain usable. Invalid or
revoked keys return undefined; the fixed UUID length rejects huge strings before
a map lookup. Boxed String revocation preserves throwing string conversions.

`web_worker.ts` resolves object URLs through the same registry. This replaces its
separate map and keeps TypeScript File names available to the existing worker
transpiler. No host ABI, provider contract, or public custom API is added.

`tests/fixtures/url-compatibility` checks the public API on the real guests.
`scripts/url-compatibility.test.ts` runs the emitted production factories with
native URL parsing and separately checks that a resolved Blob cannot mutate the
registry's bytes. The unchanged upstream web URL file now imports its resolver
and can execute its named tests.

[Ledger scope and pinned revisions](scope.md).
