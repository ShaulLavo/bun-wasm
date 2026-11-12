# Ordinary JSC producer delivery

Status: Approved. Implementation in progress.

The normal Rust producer builds and validates the private split JSC pair but does
not export it. Retain the already-built core, side, and original core, engine,
build, and embedding receipts after the existing embedding and native gates.
Keep cached component origins separate from the composing source. Export only
when the existing source selection built JSC. Do not add a build or gate.

The Engines coordinator owns independent review, CI, merge, successful normal
producer intake, and consumer delivery. Working evidence and exact intake
commands live in `/work/reports/wave-20261112/engines-active/ordinary-jsc-delivery`.
