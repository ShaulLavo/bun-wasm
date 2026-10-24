## Filesystem vectored reads

Class **Host feature**. `crates/bunwasm-runtime/src/js/node_fs.js` adds original
`readvSync`, callback `readv`, and `FileHandle.readv` adapters over the existing
Rust `read` native. No Bun or Node implementation is copied or adapted. Public
behaviour is measured against Bun 1.4.2 (`744846f84`) and Node 26.7.0. Positively
identified regular files read one view at a time, stopping at the first short
read or EOF; subsequent explicit positions advance only by committed bytes.
Errors after progress return the committed prefix. No allocation or native read
request uses the vector's combined capacity: 1024 aliases of one 4 MiB view over
an eight-byte file stop after the first view-sized request.

Non-regular descriptors (pipes, terminals and sockets), and descriptors whose
metadata is unavailable, perform exactly one read capped at 64 KiB, then scatter
its possibly short result in vector order. This avoids blocking on a second read
after filling an earlier view. It also bounds the sequential process-stdin
waiter's staging allocation to 64 KiB; stdin keeps EAGAIN, saved async context,
EOF and errno handling without waiting for more input after progress. The JSC
C API explicitly does not guarantee `JSObjectGetTypedArrayBytesPtr` pointers
across subsequent API calls (`JSTypedArray.h`, WebKit
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb`), so this adapter does not collect
unpinned engine pointers for a zero-copy native iovec call.

At most 1024 views participate, while every supplied view is validated. Writes
stay within each borrowed view and leave bytes after EOF unchanged. Positioned
reads retain the shared open-file cursor. Only nonnegative safe integer positions
select a positioned read, matching Bun's observed coercion. Callbacks deliver the
original array on a later turn. Explicitly positioned stdin keeps the native
positional-read path rather than silently discarding its position.

Bun returns zero for an empty vector `[]`, including a closed positive fd,
without issuing a native read. Node returns EINVAL instead; this known difference
is excluded from the shared Bun/Node parity cases. Both validate fd argument
shape, and a nonempty vector containing only empty views still validates the
actual descriptor. A closed FileHandle rejects even `readv([])`. Counted native
fixtures exercise short reads, overlapping and offset DataViews, EOF, argument
ordering, 1024 large aliases, bounded native requests and callback identity.
A production-factory subprocess fixture uses real kernel pipes with the writer
held open: both a short first view and a completely filled first view must return
without another read. The parent enforces a deadline and owns writer closure,
child termination and reaping. Separate native-reference fixtures keep the
shared behaviour and Bun-only empty-vector contract apart; those fixtures own
and remove their temporary input files. Browser acceptance adds real inherited-file
positioned/sequential cursor checks and process-stdin short-read/EOF scattering,
including mixed offset views and callback identity. The external root retains
its final cursor check and owns all opened descriptors.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Filesystem vectored reads](#filesystem-vectored-reads) | Host feature | Original readv/readvSync and FileHandle.readv adapters avoid summed-capacity allocations, use one bounded read for non-regular descriptors, preserve shared cursors and follow Bun's empty-vector contract. |
