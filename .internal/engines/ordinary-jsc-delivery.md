# Ordinary JSC producer delivery

Status: Approved. Both source units implemented; coordinator review and CI pending.

The normal Rust producer builds and validates the private split JSC pair but does
not export it. Retain the already-built core, side, and original core, engine,
build, and embedding receipts after the existing embedding and native gates.
Keep cached component origins separate from the composing source. Export only
when the existing source selection built JSC. Do not add a build or gate.

The Engines coordinator owns independent review, CI, merge, successful normal
producer intake, and consumer delivery. Working evidence and exact intake
commands live in `/work/reports/wave-20261112/engines-active/ordinary-jsc-delivery`.

The same source claim owns the standard Browser publication delivery gap. CI's
one host-engine compile now uses the maintained standard Browser recipe. Native,
Web, source-cache and transfer checks reuse that output. The complete
`browser-program` artifact retains Browser and tools with unchanged receipts,
source and file identities after existing Web gates. All CI consumers use its
new name and path; C1 keeps its real separate `source-cache-browser` variant.
The exact `browser` publication guard stays unchanged. No second build is added.
