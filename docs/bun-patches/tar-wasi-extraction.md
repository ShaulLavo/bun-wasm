## Tar WASI extraction

Class **Port**. `third_party/tar/` copies the published `tar` 0.4.46 package,
upstream `composefs/tar-rs` revision `fc459c149f83bf4daceaa52e17d351989002e1a9`.
Its MIT and Apache licenses are retained. Cargo resolves both runtime and installer
tar consumers through this local crate. Registry cache marker files are omitted.

`src/lib.rs`, `src/entry.rs` and the Cargo manifests change. The library enables
Rust's WASI filesystem extensions on WASI. Extraction creates symlinks with
`std::os::wasi::fs::symlink_path`. An original adapter sets symlink timestamps
through `wasi` 0.11's `path_filestat_set_times`, with no-follow lookup flags and
checked nanosecond conversion. `filetime` has no wasm implementation of that
operation. Permission application succeeds without changing mode bits because
WASI Preview 1 exposes no chmod operation. Upstream rejects these filesystem
operations on every wasm target, causing otherwise valid extraction to fail.
Other targets keep their original filesystem behavior. Header parsing,
destination checks, link checks and archive writing remain upstream code.

`src/entry.rs` and `src/archive.rs` also bound extension metadata: GNU long-name
and long-link records and PAX extension bodies are held in memory before their
member is parsed, so a body over 1 MiB is drained in 8 KiB copies and ignored, as
libarchive (Bun's tar reader) does; up to 1 MiB the record applies unchanged.
Upstream reads the declared body whole.

`src/pax_sparse.rs` is an original adapter for GNU PAX sparse 1.0 members, matching
the format produced by GNU tar and Bun's pinned `test/js/bun/archive.test.ts`.
The parser validates decimal map values, block order, logical size and stored
payload length, then builds the upstream `EntryIo::Pad` and `EntryIo::Data` list.
`src/archive.rs` dispatches PAX members to it. Existing GNU sparse parsing and the
upstream extraction and seeking paths remain intact. Other GNU PAX sparse
versions report an unsupported-format error.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`third_party/tar/src/entry.rs`, symlink timestamp adapter](#tar-wasi-extraction) | Host feature | Original Rust adapter for no-follow WASI timestamp updates. |
| [`third_party/tar/src/pax_sparse.rs`, GNU PAX sparse adapter](#tar-wasi-extraction) | Host feature | Original GNU PAX sparse 1.0 parser that feeds the upstream sparse block reader. |
| [`third_party/tar/`, WASI extraction](#tar-wasi-extraction) | Port | WASI symlink support and permission handling over the unchanged tar extractor. |
