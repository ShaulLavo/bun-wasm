# Filesystem flags, bigint stats and copy options

Class **Host feature**. These are original Bun/Node API adapters. No upstream implementation is copied or adapted.

`crates/bunwasm-runtime/src/js/fs_options.ts` implements the public string-to-numeric open flag mapping, numeric and bigint Stats objects, and synchronous/asynchronous copy filtering. `node_fs.js` forwards flags, stat options and FileHandle options to the native bindings. Copy traversal lives beside the JavaScript filter because filters can be asynchronous. It delegates metadata, directories and byte copying to the existing native filesystem operations.

The filesystem regions of `crates/bunwasm-runtime/src/natives.rs` translate public Node flag bits to the target libc constants without adding create or truncate. The existing `writeFile` convenience binding remains for BunFile's append boolean; Node's `writeFileFlags` binding carries the full caller flags. Both call the same write helper. Exclusive copies open destinations with `create_new`, so checking and creating cannot race.

Bigint stat calls serialize integer metadata with `Val::BigUint` before any float conversion. Timestamp nanoseconds and integer milliseconds use decimal strings across the engine-neutral boundary, then the Stats constructor turns them into BigInts. This also represents negative timestamps and timestamps outside a 64-bit nanosecond range. Dates convert milliseconds to numbers only for the Date API. Normal Stats retain numeric fields and omit nanoseconds.

The reference contracts are Node's `lib/fs.js`, `lib/internal/fs/utils.js` and `lib/internal/fs/cp/{cp,cp-sync}.js` at Node v24.22.1, and Bun 1.4.4's public filesystem APIs, observed as executable controls rather than copied source. Supplied reproductions audited bun-wasm `72d1394484dcd64b051f63f230ad70bfaf2769ae`; this change starts at `114b84c3a7b0f9c57df5e2daff5aa9d4d645ea3f`.

Waffle at `b20fad173ebaa225cb87c51776f35edaaafd4a40` already supplies create, exclusive, truncate and append semantics. NONBLOCK support remains Waffle #111; unsupported open bits fail explicitly here. Link-count accuracy remains Waffle #115. Cold persistent-file hydration remains Waffle #112. Bigint representation does not repair incorrect underlying metadata. This change does not implement those capabilities in the consumer.
