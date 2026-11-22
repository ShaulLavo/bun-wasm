## Guest-namespace symlinks

Class **Host feature**, **original adapter** in
`crates/bunwasm-host/src/process/wasi/links.rs`, with descriptor path tracking in
`crates/bunwasm-host/src/process/wasi.rs`. No upstream implementation is copied.

Wasmtime 39's preview1 filesystem (cap-std 3.4) answers EPERM when a symlink target is
absolute, whether creating, reading or following it, and when a path climbs above the
descriptor it starts from. Linux allows both. Bun's own tests create absolute links all the
time (`fs.symlinkSync(join(tmp, "a"), ...)`, `cp` of symlinks, `realpath`), so they failed
with `EACCES: permission denied, symlink`.

The native launcher keeps Wasmtime as the first try for every path call
(`path_open`, `path_filestat_get`, `path_filestat_set_times`, `path_create_directory`,
`path_remove_directory`, `path_unlink_file`, `path_rename`, `path_link`, `path_readlink`,
`path_symlink`) and retries only its EPERM:

- The path is walked component by component in the guest namespace, starting at the guest
  path the descriptor was opened with. An absolute target restarts at guest `/`, `..` stops at
  guest `/`, every component but the last must be a directory, and at most 40 links are
  followed (then ELOOP). A trailing `/` follows a final link, as on Linux.
- The call is repeated on Wasmtime from the deepest preopen holding the result, with a
  relative path that has no symlink left to follow, through private scratch memory.
- `path_readlink` and `path_symlink` read and store the target as written, through cap-std
  directories opened on the preopens (`read_link_contents`, `symlink_contents`).

A retry starts from the guest path each descriptor was opened with. A rename by the guest moves
the recorded paths of descriptors open on or under the renamed directory, as Linux keeps them on
the moved directory. A rename by the host (or another program) is not seen: a retry from such a
descriptor answers ENOENT, or resolves from whatever now sits at the old name, never outside the
preopens. With nested preopens, a call Wasmtime answers itself (no EPERM) keeps Wasmtime's
behavior, so `sub/x.txt` from `/` reads the outer preopen's copy when `/sub` is also a preopen;
the launcher preopens one directory today.

Every lookup runs through cap-std handles on the preopens, so neither a link nor `..` reaches a
host path outside them (`crates/bunwasm-host/src/slots/tests/links.rs` checks absolute,
climbing and host-made links).
Absolute targets are stored on the host as the guest wrote them, so a host program that
follows one outside the launcher resolves it against the host's root, as with any link a
Linux container writes into a bind mount.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-host/src/process/wasi/links.rs`](#guest-namespace-symlinks) | Host feature | Original guest-namespace retry of preview1 path calls refused by cap-std, and absolute symlink creation and reading. |

[Ledger scope and pinned revisions](scope.md).
