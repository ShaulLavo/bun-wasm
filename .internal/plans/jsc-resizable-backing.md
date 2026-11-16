# JSC resizable backing

Status: Approved. Parent Engines owns independent implementation review, CI and merge.

The WASI C-loop engine uses an explicit nonshared malloc backing kind. Its logical maximum is metadata, while retained page-rounded capacity is allocated and charged as needed. Shrink retains capacity and clears removed bytes. A successful noncollecting growth publishes the handle, contents and every incoming JS view before any heap notification or collection. Native wrappers reload the current base. Failed attempts roll pending charges back before retry or reclamation.

Preserving transfer completes fallible growth before detaching its source. Public resize and transfer lengths stay wide through coercion and detached validation. Fixed transfer checks its destination bound. Existing shared-constructor rejection remains intact, and shared contents reject the malloc kind. No profile or memory maximum changes.

Deterministic native controls force movement, both refusal points, pressure and retry. They inspect publication, charge rollback, transfer lifetime and final release. The same-source prebuild remains read-only. Common fixtures cover callback/coercion/species paths and large zeroing ranges; a JSC-only fixture exercises its ordinary memory-cap failure. Existing construction, concat and decoder checks now include JSC.

See `docs/bun-patches/jsc-resizable-backing.md` for upstream paths and classifications. Working evidence is under `/work/reports/wave-20261116/engines/jsc-resizable-backing/`.
