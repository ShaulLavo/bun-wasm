## Node WASI guest-namespace symlinks

Class **Host feature**, **original adapter** in `web/scripts/node-links.ts`, installed by
`web/scripts/node-process.ts` below Waffle's descriptor layer, on Node WASI's own descriptors.
No upstream implementation is copied.

The Node host (`web/scripts/node-host.ts`, the census Browser engine) runs the guest on
Node 26's `node:wasi` (uvwasi). uvwasi refuses a symlink with an absolute target (EPERM), and it
lets the host kernel follow every intermediate link, so a relative link that climbs out of a
preopen (`../../../../etc`) let the guest read host files.

Every preview1 path call (`path_open`, `path_filestat_get`, `path_filestat_set_times`,
`path_create_directory`, `path_remove_directory`, `path_unlink_file`, `path_rename`,
`path_link`, `path_readlink`) is now resolved before uvwasi sees it, the way Linux would inside
the guest namespace: an absolute target restarts at guest `/`, `..` stops at guest `/`, every
component but the last must be a directory, at most 40 links are followed (then ELOOP), and a
trailing `/` follows a final link. uvwasi then receives the deepest preopen holding the result and
a relative path with no link for the kernel to follow. The rewritten path is written briefly into
guest memory, NUL-terminated (Node reads a followed path up to a NUL, see the upstream bug list),
and the bytes are restored after the call; the guest is one agent blocked in the call.
`path_symlink` stores the target as written with `fs.symlinkSync` under the resolved parent.

uvwasi's `path_open` never passes `O_NOFOLLOW` to the kernel, so an open that doesn't follow its
final component checks it here: a final link answers ELOOP, and `O_CREAT|O_EXCL` (which never
follows) answers EEXIST for anything already there, a dangling link included.

Calls from a preopen whose path has no `..`, no link in its parent chain and no final link to
follow pass to uvwasi unchanged, but only from the deepest preopen holding the path, so nested
preopens (`/` and `/bin`) give one answer. Calls from any other directory are always resolved
from that directory's recorded guest path. A rename by this process moves the recorded paths; a
rename by the host or another process is not seen, so a call from a descriptor under it answers
ENOENT (or resolves from whatever now sits at the old name) where Linux would follow the
directory, never reaching outside the preopens. Node has no `openat2(RESOLVE_BENEATH)`: a link
swapped in by another process between this walk and uvwasi's call is the one gap left.
`web/tests/node-links.test.ts` checks absolute, climbing, host-made, renamed-directory, no-follow,
exclusive-creation and nested-preopen cases.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`web/scripts/node-links.ts`](#node-wasi-guest-namespace-symlinks) | Host feature | Original guest-namespace resolution of Node WASI path calls and absolute symlink creation. |

[Ledger scope and pinned revisions](scope.md).
