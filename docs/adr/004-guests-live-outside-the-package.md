# 004. Keep guest wasm outside the package, immutable and hash-verified

Status: accepted
Date: 2026-10-18

## Context

The `bun-wasm` package is a Git dependency that a page installs with Bun's `prepare` script. A guest is 9 to 43 MB. Static hosts cap file sizes (Cloudflare Workers assets cap at 25 MiB, and `bun-jsc.wasm` is 43 MB raw). A guest must also match the host package's source revision, because the host and the guest share an ABI and a stale guest broke `fs.readv` once.

## Decision

The package ships no `.wasm` file. `loadBunWasm` downloads the published guest from an immutable, hash-addressed object store, checks its decompressed byte count and SHA-256 against the descriptor in `src/guest-asset.generated.ts`, and only then compiles it. Publishing uploads a guest only after the matching builds pass the browser interruption gate in Chromium, Firefox and WebKit, and writes the descriptor only after reading the public URL back. A compiled `module` option skips the network for offline pages.

## Alternatives considered

- **Bundle the wasm in the package.** It bloats every install and every Git checkout, and it cannot hold the 43 MB JSC guest on a static host.
- **A mutable `bun.wasm.gz` URL on the site.** It breaks silently when the host package and the guest drift apart. An old mutable URL is the failure this decision removes.
- **Trust the download.** A truncated or substituted guest would compile. The loader stops streaming once the body exceeds the declared size plus a 64 KiB allowance.

## Consequences

Every consumer fetches 14.5 MB on first load unless it passes `module`. The release flow has real cost: matching builds of all three guests, a three-browser gate, and an upload. Only the default browser guest has a published descriptor. QuickJS and JSC users supply their own. See [Browser package](../browser-package.md) and [Guest artifact publishing](../guest-publishing.md).
