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


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [JSC prebuild inputs](#jsc-prebuild-inputs) | Host feature | Original build-cache fingerprint and content-preserving config staging avoid rebuilding unchanged WebKit objects for workstation scratch policy. |

[Ledger scope and pinned revisions](scope.md).
