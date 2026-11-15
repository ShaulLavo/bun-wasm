# SpiderMonkey canonical namespace marker and brand

Status: Approved. Implementation in progress.

The native namespace remains the engine's canonical object. Require, static
import, dynamic import and namespace reexports must retain its identity and live
bindings. A null-rooted prototype supplies a non-enumerable, read-only
`__esModule=true` marker. Explicit exports with that name take precedence.
The engine brand check must reject fabricated objects and proxies without
running user code. Namespace export descriptors and write rejection stay native.

The selected normal baseline is main `4b8531d7`, run 43645625036, consumed
without mutation from its original shared-group packet. It fails the existing
marker assertion with actual `undefined`. This is baseline evidence, not a
current-main or candidate pass. Focused fixture assertions also distinguish
descriptors, marker, brand, canonical identity and live exports.

Stack released module code for this unit. Its parser, property lookup, call-loop
and guard hunks remain separately owned. No stack-safety changes belong here.

Evidence and resource ownership live under
`/work/reports/wave-20261115/engines/sm-namespace/`.
