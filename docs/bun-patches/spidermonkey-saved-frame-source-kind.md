# SpiderMonkey SavedFrame source kind

This port and host feature patches Mozilla revision
`a5df22d986d4b626f771b4f8885241941601c35c` through
`spidermonkey/spidermonkey-wasi.patch`. A SavedFrame's source string comes
either from its script's `//# sourceURL` (displayURL) or from the script's
compiler filename. SpiderMonkey made that choice at capture time and dropped it.
The adapter encodes NUL and percent in compiler filenames
([filename record](spidermonkey-filenames.md)), so it must decode Filename
labels and leave sourceURL labels unchanged. The patch keeps the choice with
each frame.

| Upstream path | Local change and reason |
| --- | --- |
| `js/public/SavedFrameAPI.h` | Add `JS::SavedFrameSourceKind` (`DisplayURL`, `Filename`). Declare `JS::GetSavedFrameSourceKind` only under `__wasi__ && BUNWASM_EMBED`. |
| `js/src/vm/SavedFrame.h` | Include the API header for the enum, add `getSourceKind`, and add a required kind parameter to both principals initializers. |
| `js/src/vm/SavedStacks.h` | Store the kind in `LocationValue` beside the source atom, with a getter and setter. |
| `js/src/vm/SavedStacks.cpp` | Record the kind in the same branch that picks the atom, including the memoized PC location and the reused Wasm location. Carry it through `SavedFrame::Lookup`, its copy from an existing frame, `initFromLookup`, the hash and the match. Define the guarded accessor exactly like `GetSavedFrameSourceId`. |
| `js/src/vm/StructuredClone.cpp` | Cloned frames report `DisplayURL`. |

## Storage and lifetime

The kind is bit 1 of the existing `JSSLOT_PRINCIPALS` private word. Bit 0 stays
`mutedErrors`, and `getPrincipals` masks both bits, so finalization still drops
the exact principals pointer. A static assertion requires `JSPrincipals`
alignment above the flag bits. `JSSLOT_COUNT` is unchanged, so a SavedFrame
keeps its size. The kind lives and dies with its frame. There is no registry and
nothing keyed by script or source ID, so a retained Error keeps its kind after
its script and script-private value are collected.

## Interning

SavedFrames are hash-consed on label, position, name, cause, parent, principals
and mutedErrors, but not source ID. Without the kind in the match, a literal
`//# sourceURL=/literal%00%25.ts` and the encoded compiler name of
`/literal<NUL>%.ts` at the same position would share one frame and one kind.
The kind is in both the hash and the match. Frames with equal labels and equal
kinds still share one frame and its first source ID, as upstream does.

## Opaque labels

Structured-clone and heap-snapshot reconstruction carry no provenance. Their
frames report `DisplayURL`, meaning the label is opaque and stays raw. This is
not a recovered sourceURL fact, and an encoded compiler label read through those
paths stays encoded. The adapter installs neither path.

## Behavior outside the embed build

The public accessor is guarded. The internal kind is not. Without
`BUNWASM_EMBED`, frames that differ only in kind are no longer shared, which can
change SavedFrame object identity and which shared source ID a frame reports.
No other behavior changes.

## Controls

`crates/bunwasm-spidermonkey/tests/filename-controls.cpp` runs on both tiers in
the engine-semantics `filename` and ordinary modes. It covers ordinary, percent,
NUL and Unicode compiler names; direct, eval and Function sourceURL with percent
and Unicode text; inherited eval, Function and nested names; an inner eval in a
sourceURL script; same-position collisions in both capture orders; same-kind
sharing; retained Errors after their script privates are released; self-hosted
selection; an explicit async parent copy; null frames; and non-null principals
with both mutedErrors values, denied principals and balanced holds. It formats
each case with the production `inspect.js`, which `build.rs` embeds for controls
only.
