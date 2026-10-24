# 001. Run the runtime on three engines behind one trait

Status: accepted
Date: 2026-10-15

## Context

Bun runs on JavaScriptCore, and its native code (about 12 MB of C++ bindings) is written against JavaScriptCore internals. JavaScriptCore cannot generate code at run time inside wasm, so a wasm build has no JIT tier and runs as an interpreter. Bun's Rust and C++ bridge also assumes a 64-bit machine, while wasm32 pointers are 32 bits.

A browser already ships a fast JavaScript engine. A page that runs a wasm guest has to decide whether the guest carries its own engine or borrows the page's.

## Decision

The runtime talks to a JavaScript engine through the `Engine` trait (`crates/bunwasm-runtime/src/engine.rs`) and ships three implementations as three guests. QuickJS-ng is the default (`bun.wasm`). JavaScriptCore without JIT is an experiment (`bun-jsc.wasm`). The `browser` engine leaves the engine out of the wasm and runs the runtime's JavaScript on the host's own engine (`bun-browser.wasm`).

## Alternatives considered

- **Run Bun's real runtime on JavaScriptCore in wasm.** A spike found a single-threaded port feasible but large. It needs a value bridge for the 32-bit pointer width, platform branches, and an adaptation of Bun's event loop and sockets. It would also inherit the no-JIT interpreter speed. The spike recommended one bounded milestone before any commitment, and nothing replaced the runtime.
- **JavaScriptCore only.** It matches Bun's semantics best, but its guest is 43 MB and runs without JIT. It stays as an option, not the default.
- **QuickJS only.** It is the smallest wasm engine, but the page already has an engine with a JIT, so carrying a second one buys fidelity at the cost of speed.

## Consequences

One engine-independent runtime serves three guests, and an engine-specific behavior has to stay behind the trait. Every fixture runs on every engine, so a regression shows up as a difference.

The `browser` engine gives JIT speed and costs fidelity. The host engine exposes neither promise state nor async context, so the runtime reconstructs both, and import cycles need a module store ([The browser engine](../engine-browser.md)). A fix in shared runtime code can pass on two engines and fail on the third.

Three guests triple the build matrix and the size of the published artifacts. The generated descriptor names one guest, the default browser guest.
