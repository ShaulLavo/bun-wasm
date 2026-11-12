# Ordinary JSC producer delivery

Status: Approved. JSC export implemented; coordinator review and CI pending.

The normal Rust producer builds and validates the private split JSC pair but does
not export it. Retain the already-built core, side, and original core, engine,
build, and embedding receipts after the existing embedding and native gates.
Keep cached component origins separate from the composing source. Export only
when the existing source selection built JSC. Do not add a build or gate.

The Engines coordinator owns independent review, CI, merge, successful normal
producer intake, and consumer delivery. Working evidence and exact intake
commands live in `/work/reports/wave-20261112/engines-active/ordinary-jsc-delivery`.

The same source claim owns the standard Browser publication delivery gap. Current
normal CI builds only `source-cache-browser`. The standard `browser` build runs
in the separate maintained publication controller. Before adding any build,
consolidate CI's one host-engine compile onto the standard Browser recipe and
reuse that output for the existing source-cache consumers. Keep the exact
`browser` receipt guard. The report records the recipe, gates, and affected
contracts; this PR does not add a second Browser compile.
