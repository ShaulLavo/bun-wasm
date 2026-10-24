### Intl fallback adapter

`crates/bunwasm-runtime/src/js/intl.ts`. Class **Host feature**, an **original adapter**, not a copied Bun or WebKit implementation. Comparison sources are Bun's pinned WebKit `Source/JavaScriptCore/runtime/Intl*.cpp` at `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`. The existing fallback supplies en-US formatting, segmentation and locale behavior only where bootstrap does not select authoritative engine Intl constructors. The strict TypeScript conversion adds option, part and segment contracts. Locale fields use type-only declarations, so construction and property assignment order remain unchanged.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/intl.ts`](#intl-fallback-adapter) | Host feature | Original en-US fallback for engines without the corresponding native Intl constructors. |

[Parent context](bun-patch-series.md).
