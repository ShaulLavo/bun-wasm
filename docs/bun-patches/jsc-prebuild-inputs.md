## JSC prebuild inputs

Class **Host feature**, original build adapters in `jsc/common.sh` and
`scripts/jsc-inputs.test.ts`; no upstream source is copied or changed. WebKit stays
at `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`. The prebuild stamp fingerprints
effective compiler, SDK and include/link environment inputs rather than all of
`env.sh`, whose unrelated workstation scratch settings cannot change the engine.
Existing script, configuration, shim and tool-version fingerprints remain.
Staging compares configuration bytes before copying, preserving an unchanged
injected header's timestamp instead of recompiling every dependent C++ object.
Regression controls prove scratch-policy edits leave the stamp unchanged,
compiler/header changes invalidate it, and identical staged files keep their
timestamps. Stamp refresh still runs the normal incremental build; no check is
bypassed.


CI derives its prebuild key from this same stamp contract after the patched
sysroot has been verified. It does not hash unrelated lockfile or environment
file edits. Host compiler commands and versions, linker and SDK environment
variables also participate. A restored tree must retain its pinned WebKit commit,
tracked patch bytes and clean untracked state. Archive and shell hashes reject
partial or corrupted outputs. The existing WASI CMake preflight still verifies
compiler, SDK, toolchain and sysroot paths before reuse. Completed prebuilds are
saved before native quality checks, guest fixtures and assertions. Ordered Actions
steps trade cold-only overlap for a durable completed cache before a later timeout. A missing completion output never permits a save.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [JSC prebuild inputs](#jsc-prebuild-inputs) | Host feature | Original build-cache fingerprint, output integrity checks and early CI saves reuse only completed matching WebKit builds. |

[Ledger scope and pinned revisions](scope.md).
