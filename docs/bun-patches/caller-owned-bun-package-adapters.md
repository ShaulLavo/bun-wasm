## Caller-owned Bun package adapters

`src/{index,bun-adapter,assets,guest-asset.generated,worker-entry}.ts`, `build.ts`,
`prepare.ts`, and `scripts/{guest-artifact,publish-guest}.ts` are original bun-wasm
adapters and tooling, not copied or adapted upstream implementations. They register
Bun names and executable markers on the caller-owned Waffle runtime, export the existing worker without demo
code, verify decompressed guest size and SHA-256 before compilation, and publish
content-addressed guest objects without replacing differing content. Process launching
uses the generic `runtime_proc` bridge. The default descriptor points to the
browser-engine guest built from implementation merge
`06e089070491d0e0222b131425167ef08ec786c3`; its 15,174,690 decompressed bytes hash to
`2a7dafbf3396f8472adffcf7e906266fa9df7dc5e185108102e2706a28a08cfc`.
Publication verified raw gzip metadata, immutable cache directives, wildcard
cross-origin access, decompressed size and SHA-256 before descriptor generation.
The external-runtime gate has an explicit published-default mode that supplies
only the worker URL, asserts exactly one public guest request without a local
fallback, and executes the real Bun process scenarios. QuickJS/JSC remain
explicit module/asset opt-ins; neither was published by this follow-up.

Waffle is consumed unchanged as a pinned Git peer/development dependency; the package
does not embed its implementation or create a second runtime. Existing worker and net
imports use explicit extensions for strict module resolution. No upstream patch or
copied implementation was introduced by this packaging work.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Caller-owned Bun package adapters](#caller-owned-bun-package-adapters) | Host feature | Original Waffle registration boundary, verified asset loader, package build and immutable guest publication tooling. |
