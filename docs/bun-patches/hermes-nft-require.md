# Hermes Next NFT require lookup

## Classification

| Source | Class | Origin and change |
| --- | --- | --- |
| Next 16.4.3 `dist/compiled/@vercel/nft/index.js` | Upstream reference | MIT-licensed ncc bundle of `@vercel/nft`, not checked in. npm tarball SHA-256 `d37409b7530c4873cd14c0619a7b8734777fd0dc2cae627bb592e5a82f74f8f4`; 283,000-byte file SHA-256 `e436d398b2263fb87a2d8ee3d9dab8db2544c684ba9bc1c0d4ab4e67acbab207`. |
| `crates/bunwasm-engine-hermes/src/source.rs` NFT entry | Original adapter | Lowers the two exact-shape single-identifier require lookups before Hermes compilation. |
| `tests/hermes/nft-require.cts` | Original test adapter | Synthetic source checks binding identity, module-relative resolution, late calls, absent global require and rejected path/source shapes. No upstream implementation is copied. |

## Scope and semantics

Hermes evaluates direct-eval strings in global scope rather than the caller's lexical
scope. The full Next build reached the NFT import in `next-trace-entrypoints-plugin.js`
after the process child entered its main module. An isolated unchanged-input guest
probe attributed the throw to factory 5017's `var runtimeRequire=true?eval("require"):0;`.
The initial processChild require lookup is a separate, previously addressed boundary.

The adapter applies only to filenames ending in
`/node_modules/next/dist/compiled/@vercel/nft/index.js`. It requires exactly one
`var runtimeRequire=true?eval("require"):0;`, exactly one
`var requireFunc=true?eval("require"):0;`, and exactly two `eval("require")` literals.
Unmatched paths, missing or duplicate anchors, extra lookups and already adapted
source stay borrowed and unchanged. Nested installations and CommonJS wrappers keep
the same scope rule.

Both identifier lookups become the existing same-length `(0,require)    ` expression.
Factory 5017 is runtime-proven. Factory 8441's `requireFunc` lookup is included by a
static scope check of this exact published input, not by a claim that its failure was
observed. Neither site shadows `eval` or `require`, and the input contains no `with`.
Both therefore read the CommonJS wrapper's real module-relative require. The literal
and shape guards limit the known transformation; they are not a general JavaScript
scope parser.

The replacement reads the binding when each initializer runs. The 8441 function
therefore reads it on each late call rather than capturing an eager value. Both forms
produce a value instead of a receiver-bearing reference. No global require is installed.
The replacement preserves source length, lines and columns. Function source inspection
can reveal the adapted text; the published NFT input does not inspect its own source.
The existing jest-worker adapter remains unchanged.

## Residual and verification limits

The nbind locator's `eval("require.resolve(basePath)")` and
`eval("require.resolve(resolvedPath)")` expressions are left alone. They read local
variables, are guarded by upstream `try/catch`, and were not observed in the failing
Next path. This change does not adapt any other compiled module.

The source tests run in the existing Hermes crate's Rust workspace test pass. The
synthetic guest fixture belongs to the existing Hermes fixture runner. It discriminates
module-relative resolution from the working directory and checks both late binding and
negative path/source guards. Passing source controls do not establish a full Next build
pass. Guest green and an unchanged published NFT load require the reviewed rebuilt
artifact from the canonical producer.
