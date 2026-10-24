## Native executable admission

Class **Host feature**, **original adapter** in
`crates/bunwasm-host/src/process/executables.rs`; no upstream implementation is
copied. It adapts Waffle's `proc/registry.ts`, `proc/access.ts` and
`proc/worker-client.ts` contracts at the consuming package's pinned revision.
The native host creates real guest-visible executable files for `/bin/bun` and
`/bin/node`. Explicit `--engine quickjs=PATH` and `--engine jsc=PATH` registrations
own `/opt/bun/<engine>/bin/{bun,node}` and their exact modules; no root-ancestry
rewrite chooses an engine. Access queries observe the live filesystem, retain a
process-owned request until take/cancel, and spawn independently rechecks
admission. Native process admission matches Waffle b1f2b7dd's default 1024-slot
process directory, including the root and completed children until consuming
wait; exhaustion returns EAGAIN. Executable aliases resolve component by component in the
guest namespace: absolute symlink targets begin at guest `/`, relative targets begin at the
link's parent, and missing/non-directory components before `..` remain errors. Resolution
is bounded to 40 links. After that original-component walk succeeds, the resolved guest
path must equal the lexical registration key: aliases that change that key are rejected
with EACCES, matching pinned Waffle `0a9fe12b` and the Node host. Waffle's browser filesystem
does not implement symlinks. Admission returns the absolute canonical guest path, never a host
canonical path. Marker directories and access threads are owned and cleaned by the native
runtime. These traversal rules are an original Rust adapter, not copied filesystem code.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-host/src/process/executables.rs`](#native-executable-admission) | Host feature | Original native executable markers, exact module selection and live process-owned access requests. |

[Ledger scope and pinned revisions](scope.md).
