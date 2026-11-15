# SpiderMonkey canonical namespace marker and brand

Status: Approved. Focused implementation and validation complete; independent
review and normal CI belong to the Engines coordinator.

The native namespace remains the engine's canonical object. Require, static
import, dynamic import and namespace reexports must retain its identity and live
bindings. A null-rooted prototype supplies a non-enumerable, read-only
`__esModule=true` marker. Explicit exports with that name take precedence.
The engine brand check must reject fabricated objects and proxies without
running user code. Namespace export descriptors and write rejection stay native.

The selected normal baseline is main `4b8531d7`, run 43645625036, consumed
without mutation from its original shared-group packet. It fails the existing
marker assertion with actual `undefined`. This is baseline evidence, not a
current-main pass. A development side built from the normal `1f349936f` shared
native donor replaces only the namespace and JSAPI unified objects. With the
same baseline core and launcher, all 20 focused guest checks pass across both
tiers. The namespace fixture passes three times per tier. Direct JSAPI controls
also pass three times per tier, and both existing module-control runs pass.

The inherited marker uses otherwise-unused global application slot zero,
which SpiderMonkey already traces. Export bindings and their descriptors stay
native. Prototype mutation tests cover inherited string and symbol getters,
without treating them as own exports or conferring the namespace brand.
The same fixture passes on normal baseline QuickJS and JSC, and native Bun.

The existing native check manifest selects QuickJS, JSC and SpiderMonkey. No
workflow command list or ordinary-fixture list gains another name.

Stack released module code for this unit. Its parser, property lookup, call-loop
and guard hunks remain separately owned. No stack-safety changes belong here.

Evidence and resource ownership live under
`/work/reports/wave-20261115/engines/sm-namespace/`.
