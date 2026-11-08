# SpiderMonkey irregexp Unicode controls

These sources implement the ICU-shaped subset used by the pinned irregexp.
They do not enable native `Intl`. C0-C2 are controls only. N1 separately builds
a fresh native library. Neither gate establishes native hello or complete ES
RegExp support.

## Classification

The Mozilla pin is `a5df22d986d4b626f771b4f8885241941601c35c`.
ICU4X dependencies and Unicode data are pinned to 2.4.0 and Unicode 18.0.0.
SpiderMonkey's own tables remain Unicode 17.0.0.

| Local source | Class | Upstream source and change |
| --- | --- | --- |
| `crates/bunwasm-spidermonkey/src/glue/properties.rs` | Adapted from Mozilla | `js/src/irregexp/properties_glue/src/lib.rs` at the Mozilla pin. Retain CWCF/CWKCF lookup, full case closure, and complement order. Extract helpers to keep nesting at three levels, and document unsafe entry contracts. C1 compares every exported mode with the upstream algorithm. Original source SHA-256: `5eff5dd636859c16d8a826b2fdd8a5f69593c56f13cc737d3451e19dec184831`. |
| `crates/bunwasm-spidermonkey/src/glue/ucd.rs` | Original adapter | Calls ICU4X's strict property parsers, property range iterators, Basic Emoji strings, default simple folding, and the `Cased` and `Case_Ignorable` sets used by the U3 `String.cpp` arm. Close a code point over the filtered ICU4X closure of its simple-fold key. Preserve surrogates as themselves. Return validity separately from callback counts. No Rust allocation occurs in these query paths. |
| `spidermonkey/irregexp-icu/include/unicode/{uchar,utypes,utf16}.h` | Adapted API definitions | Numeric constants and signatures from `intl/icu/source/common/unicode/{uchar,umachine,utypes,uset,utf16}.h` at the Mozilla pin. Provide only irregexp's names, UTF-16 iteration, and simple-fold flags. No ICU4C implementation or data is linked. |
| `spidermonkey/irregexp-icu/{icu_subset.cpp,allocator.cpp,property_data.h,ucd.h,include/unicode/{uniset,unistr,usetiter,locid}.h}` | Original adapter | ICU4C API shape only, as consumed by `js/src/irregexp`. Sorted ranges and separately owned UTF-16 strings use checked SpiderMonkey allocation. The fatal path calls `AutoEnterOOMUnsafeRegion::crash`, not a bogus or silently empty set. Strict property names live in one sorted table. |
| `crates/bunwasm-spidermonkey/src/glue/special_case.rs` | Adapted generator algorithm | `PrintSpecial`, `Canonicalize`, and `RemoveSupplementary` from `js/src/irregexp/imported/gen-regexp-special-case.cc` at the Mozilla pin. Use full-domain inverse simple-fold groups and ICU4X ROOT uppercase data instead of ICU4C. Preserve the special-add invariant check and exclude surrogates from BMP classification. Host-only, not linked into the Wasm side. |
| `spidermonkey/irregexp-icu/templates/{gen-regexp-special-case.cc,special-case.cc,irregexp/imported/special-case.h,LICENSE.v8}` | Copied | Exact pinned generator, original generated support, predicate header, and `js/src/irregexp/LICENSE.v8`. Preserve original bytes. The generator and template hashes are checked before generation. |
| `spidermonkey/irregexp-icu/generated/{special-case.cc,special-case.inputs.json}` | Generated, adapted from the pinned V8 template | `spidermonkey/generate-special-case.ts` renders the two computed sets into the pinned template. ROOT uppercase and simple folding use ICU4X 2.4.0. The receipt binds both generator implementations, the upstream files, Cargo.lock, exact crate checksums, source/data manifests, and the output hash. `--check` rejects stale output or custody. |
| `spidermonkey/generate-special-case.ts`, `crates/bunwasm-spidermonkey/examples/unicode-special-case.rs` | Original generator driver | Run the host-only adapted algorithm and render its computed sets. No character exceptions are embedded in the generator. |
| `spidermonkey/irregexp-icu/tests/`, `src/glue/ucd_tests.rs` | Original controls with adapted reference algorithm | Execute the unchanged pinned C++ predicate header against both original and generated support. The host `RegExpShim.h` substitutes only types, assertions, and static initialization. The allocator substitutes only `js/Utility.h`; it proves the allocator-to-fatal entry and exit 134, not a new native engine's fatal route. |
| `crates/bunwasm-spidermonkey/src/glue/emoji_sequences.{rs,inputs.json}` | Generated from Unicode data | `emoji-sequences.txt` and `emoji-zwj-sequences.txt` from `https://www.unicode.org/Public/18.0.0/emoji/`, emoji version 18.0, SHA-256 `1823dce71f3dd9cb0ad1976797baee4ffbdc1909756f43af8ce4c57f732843a4` and `f61b5213bdf85a57741a9f903cb38d0f39a3d13be6ff4aca3b39857e859a9191`. Keycap bases, flag letter pairs and modifier bases are stored compactly; tag and ZWJ sequences are stored one per line. The receipt binds inputs, generator files, output hash, per-property counts and checksums, and the remaining gap list. |
| `spidermonkey/emoji-sequences.ts`, `spidermonkey/generate-emoji-sequences.ts`, `crates/bunwasm-spidermonkey/src/glue/emoji.rs` | Original generator and adapter | Parse the two files, reject unknown types, ranges in sequence properties, partial modifier sets and malformed flags, tags or ZWJ sequences, then render the tables. `emoji.rs` expands them into UTF-16 strings for `bunsm_ucd_property_ranges` properties 66 to 71 without allocation. `--check --inputs DIR` replays the inputs; `--check` alone verifies recorded hashes. |
| `spidermonkey/irregexp-icu/probe.cpp`, `spidermonkey/relink-unicode-c2.sh`, `spidermonkey/unicode-c2-receipt.ts`, `spidermonkey/check-irregexp-unicode.ts` | Original controls | Inventory all compiled irregexp units. Reconstruct the retained early G3 side from its recorded execution sources and immutable native archive, then retain all Unicode paths and complete adapter objects through explicit probe exports. No `mach`, native library build, or engine bootstrap runs. |

## Selected-data correction and holds

The original C1d control failed. The pinned generated source has an empty
SupplementaryEquivalentsSet, but selected Unicode 18 folds U+00DF, U+1E9E,
and U+1DF95 together. The pinned generator comments already describe that
Unicode 18 group. The table is live: `special-case.h:98-99` feeds BMP atom
desugaring in `regexp-parser.cc:226-239`. An empty predicate bypasses
supplementary expansion before the single-unit assumption in
`regexp-compiler.cc:1562-1604`. The interpreter bytecode compiler shares it.

The coordinator-corrected control therefore generates selected-data support.
The computed IgnoreSet remains identical at 67 members. The supplementary
BMP set contains U+00DF and U+1E9E. The actual C++ predicate matches the
selected-data reference for all 65,536 BMP units, while original generated
support fails at exactly those two members. No original Mozilla tree, parser
semantics, or selected Unicode data changed. The WASI patch selects the new
source only for a future fresh native generation. Literal, class, and
backreference behavior still requires later both-tier native proof.

The resolved ICU4X 2.4.0 character-closure implementation does not recurse.
Its exception helper emits characters and a string directly. The adapter
ignores full-fold string callbacks, and C1 checks simple-fold closure against
inverse groups over all 1,114,112 code points. This is not string-closure proof.

The six U2 sequence properties are generated source and U3 Final_Sigma is a
patched source arm (see below). Test262 conformance runs, N1-N5 for that
source, and native execution remain later work. N1 wires the exact overlay bytes into the ordinary native fetch and checks
the resulting library. It does not admit a producer artifact.

## Invalid-property boundary control

`UCHAR_INVALID_CODE = -1` is an enum member, matching the pinned ICU header.
Unknown and null property names therefore return a representable `UProperty`,
not an out-of-range enum cast. `tests/enum-boundary.cpp` calls the real adapter
on null, unknown, empty and loose names, then checks a valid property. Its Rust
query link stubs are not reached by property-name lookup. Run this host control
with Clang's `-fsanitize=enum -fno-sanitize-recover=enum`; the pre-correction
header fails on the invalid-name path. The normal C1 adapter control also checks
null and unknown names. This is host boundary proof, not native VM execution.

## Property-escape lookups against test262

`bunsm_icu_host_lookup` in `tests/controls.cpp` follows the pinned irregexp
`u`-mode lookup order (general-category value, `Any`/`ASCII`/`Assigned`, then
binary property with an exact alias, or `gc`/`sc`/`scx` with a value) through
the real adapter functions. The ignored Rust test `glue_irregexp_lookup_dump`
runs it over a list prepared from the pinned test262 `property-escapes`
directory. It is evidence, not a CI check, because the list comes from the
Mozilla tree.

At this source, 3,491 positive lookups resolve. 2,795 match test262's
Unicode 17.0 lists exactly. 648 differ only at code points first assigned in
Unicode 18.0. The other 48 differ only where the Unicode 18.0 UCD changed
existing characters: new uppercase pairs for U+0277, U+027C, U+AB4B and
U+AB4C, three Arabic `Diacritic` additions, and the `Script_Extensions` of
U+1CF5, U+1CF6 and U+0B83. All 105 expected syntax errors are rejected.

The run found that `\p{space}` was rejected. The language-facing row accepts
`White_Space` and `space`, the spellings permitted by ECMAScript. ICU's additional
`WSpace` alias is rejected by both lookup and exact-alias controls. No extra-alias
table is needed. Other properties retain their existing long and short names.

## U2 properties of strings

ICU4X 2.4.0 provides `Basic_Emoji` only. `Emoji_Keycap_Sequence`,
`RGI_Emoji_Modifier_Sequence`, `RGI_Emoji_Flag_Sequence`,
`RGI_Emoji_Tag_Sequence`, `RGI_Emoji_ZWJ_Sequence` and `RGI_Emoji` come from
the generated tables. `RGI_Emoji` is ICU4X `Basic_Emoji` plus the five
sequence properties, as UTS #51 ED-27 defines it. Only the value `Y` is valid;
irregexp rejects negation of these properties before any query.

The C++ adapter appends property strings without its general duplicate scan,
because each query emits distinct strings. The host controls check that
distinctness for every property and for the `RGI_Emoji` union. No new C entry
point or ICU name is added, so the irregexp source, the WASI patch and the
native symbol contract are unchanged.

Host controls compare each property's expanded strings with the count and
checksum of its input list, prove that ICU4X `Basic_Emoji` equals the input's
`Basic_Emoji` lines (79 ranges, 207 strings, so both data sources are emoji
18.0), and exercise the real adapter for keycap, flag, modifier, tag, ZWJ and
`RGI_Emoji` sets. Every pinned test262 Unicode 17.0 string list equals
Mozilla's pinned emoji 17.0 data, and the generated lists differ from it only
by 19 emoji 18.0 additions. These are source and host controls. They do not
establish native RegExp execution; that needs a new native generation.

## U3 Final_Sigma

Without native Intl, upstream `String.prototype.toLowerCase` always maps
U+03A3 to U+03C3, so `"ΟΔΟΣ".toLowerCase()` ends in U+03C3 instead of U+03C2.
The WASI patch's `String.cpp` arm runs the upstream context scan with ICU4X
`Cased` and `Case_Ignorable` (Unicode 18.0.0) through two new Rust exports. The
rest of case mapping still uses SpiderMonkey's Unicode 17.0.0 tables, as Intl
builds also mix engine tables with ICU data. `toLocaleLowerCase` without Intl
uses the same path.

The native symbol contract now expects these two exports as Rust requirements.
Host controls check both exports against ICU4X over every code point and run
the pinned test262 `special_casing_conditional.js` and `Final_Sigma_U180E.js`
inputs through a code-point port of the upstream scan. The patched file
compiles with the retained N1 compile command, and preprocessing shows the new
arm active. No native library or VM execution has run this source.

The retained C2 relink recipe converts both baseline and probe sides through
`spidermonkey-side-core-receipt.ts convert-side`. It no longer calls the
supported-only initializer CLI. Source checks cover both recipe invocations,
and a tiny valid side exercises the experimental converter's actual CLI.
