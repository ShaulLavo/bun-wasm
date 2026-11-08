# SpiderMonkey host integration

SpiderMonkey host loading is experimental and explicit. Tiny fixtures prove this
plumbing, not Mozilla execution or G3 and G4 runtime acceptance. The normal producer,
publication packet, default engine, and engine menu still contain only Browser,
QuickJS, and JSC.

## Selection contract

The authoritative `src/engine-kind.ts` exports `Engine = PairedEngine | "browser"`.
`pairedEngineKinds` and `isPairedEngine` admit `quickjs`, `jsc`, and `spidermonkey`
for explicit host loading. `pairedEngines`, `SupportedPairedEngine`, and
`isSupportedPairedEngine` retain the ready QuickJS and JSC publication boundary.
`ProgramFiles<T>` and `parseProgramFiles` require a core and side for paired kinds.
Tiers are not engine kinds.

SpiderMonkey uses `bun-spidermonkey.wasm` with a sibling
`spidermonkey-engine.wasm`. The core must declare `spidermonkey`, and the side must
export the matching initializer and run profile. Missing sides, mismatched cores,
and QuickJS or JSC companion profiles fail rather than selecting another engine.

The package installer accepts `engine: "spidermonkey"` only with an explicit
prepared module or asset descriptor. It provisions `bun`, `node`, and `nodejs` in
`/opt/bun/spidermonkey/bin`. Default installations do not register its adapter.
Asset descriptors verify the byte count and SHA-256 of both files before linking.

The Node fixture host accepts `--engine spidermonkey=PATH`, loads that core and its
sibling side, and registers only configured engine-qualified executables. An
unconfigured path never falls back to the base module.

The browser accepts `?engine=spidermonkey` without adding a menu option. Named
standard URLs use the fingerprinted pair loader. Custom SpiderMonkey core URLs
also require both standard manifest fingerprints. The runner reuses the selected
prepared module for engine-qualified child commands.

Web staging includes SpiderMonkey only when `SPIDERMONKEY_WASM` names an explicit
core. Its sibling side is required. Both files receive gzip payloads and SHA-256
manifest entries. No SpiderMonkey guest-build recipe or qualified guest ships with
this host change. The [library build](spidermonkey-build.md) alone does not produce
a paired Bun guest.

## Child environments

Each launch supplies `BUN_WASM_SPIDERMONKEY_TIER=interp` or
`BUN_WASM_SPIDERMONKEY_TIER=pbl` in that child's environment. Concurrent children
can carry different tiers while sharing one compiled pair. PATH prefixing preserves
the tier and does not mutate the caller's environment. The native engine owns tier
validation and execution.

## Telemetry contract

Snapshots use `engine: "spidermonkey"`. Unknown heap and buffer values remain
`null`; unavailable engine counters remain absent. Existing core capacity and
allocator counters keep their meaning. The host does not call an invented
SpiderMonkey refresh export or add an ABI, GC policy, or memory cap.

## Source-only checks

`checks/quality-spidermonkey-host-plumbing.json` owns the focused host checks.
They initialize real tagged tiny pairs, exercise Node CLI selection, run concurrent
workers under Bun and Node, reject changed browser payloads, and execute the actual
optional gzip and fingerprint staging code. Package payload checks reuse the
existing packed-package fixture and initialize the pair through Node and Bun
package exports. Browser runner checks verify selected-module reuse and executable
markers without claiming a live browser runtime campaign.

The tiny companion writes `42` into core memory during initialization. These tests
prove host plumbing and environment transport, not Mozilla interpreter selection.
Focused experimental-source runs cover hello, modules, CommonJS, serve, spawn,
both tiers, and seven shared stack and IPC fixtures on QuickJS, JSC, and actual
Chromium. They do not qualify a later source tree or normal release producer.
Full G3, broader browser acceptance, and release admission remain separate gates.
The normal publication packet is unchanged and excludes SpiderMonkey.
