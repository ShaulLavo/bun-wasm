# SpiderMonkey unresolved symbol baseline

`spidermonkey/unresolved-symbols.json` is generated identity data for the original
native verifier. It contains 189 unresolved names from the retained G2 archive
with SHA-256 `a8327ca68f7052f239ac887204bac16cead4266b495d66a95a9bf80c4d4c5f26`.
The upstream source is Mozilla Firefox at
`a5df22d986d4b626f771b4f8885241941601c35c`, with the local embed changes classified
in [the G2 record](spidermonkey-g2.md). No upstream implementation was copied.

The data was extracted with wasi-sdk 34's `llvm-nm --format=posix`, after checking
the archive hash against `baselineHash` in `native-profile.ts`. `symbolSets`
collects definitions and undefined names across every member. The baseline is
the sorted, unique undefined names without a definition in any member.

`freshNativeSymbols` in `check-build.ts` turns the names into undefined-symbol
records and calls the existing `checkSymbolDelta`. It still rejects new native
requirements except the nine documented Rust entries, unresolved ICU calls,
missing Rust requirements, missing embed hooks and missing subset definitions.
Object closure, PIC, relocation, header and no-exception checks are unchanged.

Fresh hosted builds need these symbol names, not the historical archive's bytes.
Historical artifact-only qualification keeps its immutable-archive check. The
ordinary generation key and fresh library receipt include this data file's hash.
The existing native-profile quality test now exercises the cold symbol path and
each substantive symbol rejection without a local G2 archive.
