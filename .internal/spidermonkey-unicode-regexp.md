# SpiderMonkey Unicode RegExp source status

Status: Approved source work. Native acceptance needs a new native generation.

Base: `5952bf9bc046df8aa6ecb7da11e0dca5b8e076c5`, the last integrated semantics and
measurement source. Draft PR 455's bootstrap blocker (no-Intl irregexp rejecting
`\p{ID_Start}` at parse time) was already fixed in source by the ICU4X subset:
the WASI patch selects `V8_INTL_SUPPORT` for irregexp and supplies the ICU names
it uses. This work does not repeat that fix.

## What this source adds

1. U2: the six `v`-mode emoji properties of strings, generated from Unicode
   emoji 18.0 data, through the existing `bunsm_ucd_property_ranges` entry
   point. No irregexp, patch or symbol-contract change.
2. The `space` alias of `White_Space`, found by running every pinned test262
   property-escape list through the real adapter lookup.
3. U3: `Final_Sigma` for `toLowerCase` without Intl, through one guarded
   `String.cpp` arm and two Rust exports. This is the last commit
   ("Decide Final_Sigma from ICU4X case properties in SpiderMonkey") and can be
   reverted on its own; U3 then returns to the profile's `unsupported` list.

`docs/bun-patches/spidermonkey-irregexp-icu-subset.md` and
`docs/bun-patches/spidermonkey-wasi.md` record each source, input and control.

## What is proven, and how

Host and source controls only:

- Every U2 property's expanded strings match the input list's count and
  checksum. ICU4X 2.4.0 `Basic_Emoji` equals the emoji 18.0 input, so
  `RGI_Emoji` is built from one data version. Test262's Unicode 17.0 string
  lists equal Mozilla's pinned emoji 17.0 data, and the generated lists differ
  only by the 19 emoji 18.0 additions.
- All 3,491 positive test262 property-escape lookups resolve through the
  adapter, and all 105 expected syntax errors reject. Every set difference is
  a Unicode 18.0 assignment (648 lookups) or a Unicode 18.0 UCD change to an
  existing character (48 lookups: new case pairs for U+0277, U+027C, U+AB4B,
  U+AB4C; Arabic `Diacritic` additions; `Script_Extensions` of U+1CF5, U+1CF6,
  U+0B83).
- The U3 predicates match ICU4X over every code point, the test262 Final_Sigma
  inputs pass through a port of the upstream scan, and the patched
  `String.cpp` passes a syntax-only compile with the retained N1 command.

## What remains

- A new native generation (N1, N2) with these inputs. Existing native
  artifacts and receipts predate them and stay as recorded. `native-profile.ts`
  now rejects the old attempt-3 profile as a different generation.
- N3 probes in both tiers for the new cases: `/^\p{RGI_Emoji}$/v` on a ZWJ
  family, keycap, flag and tag sequence; `\p{RGI_Emoji_Flag_Sequence}` with
  `/vi`; `new RegExp("\\p{space}", "u")`; `"ΟΔΟΣ".toLowerCase()` and the two
  test262 Final_Sigma files.
- N5 in the VM: the test262 runs themselves. The source classification above
  predicts which generated tests fail only because test262 is Unicode 17.0 and
  the data is Unicode 18.0. Those failures are data deltas, not bugs.
- The engine's own case tables stay Unicode 17.0 while ICU4X data is 18.0.
  This split also exists in Intl builds and is recorded, not fixed.

## Rerunning the controls

```sh
source env.sh
node spidermonkey/generate-emoji-sequences.ts --check --inputs DIR  # DIR holds the two emoji files
cargo test -p bunwasm-spidermonkey --lib --features unicode-controls glue
bun test scripts/spidermonkey-emoji-sequences.test.ts
```

The test262 lookup harness needs a pinned Mozilla tree. Its driver and results
are kept with the lane report, outside the repository.
