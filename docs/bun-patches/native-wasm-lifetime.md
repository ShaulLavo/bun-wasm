# Native WebAssembly operation lifetime

Classification: Original adapter.

`web/src/native-wasm-lifetime.ts` belongs to the browser engine host. It wraps the host engine's asynchronous WebAssembly compilation and instantiation methods, using the existing pending-operation counter. This is original code, not copied upstream source.

Qwik 1.17.2 initializes its optimizer through `WebAssembly.compile()` from a detached Vite CLI action. The action's entry module can finish before compilation settles. Without a pending-operation reference, the browser host exits before Vite opens its listener. The in-guest engines compile synchronously within their promise implementation and do not have this host-native lifetime gap.

The wrapper preserves method names, lengths, fulfillment values and rejections. A separate returned promise preserves unhandled rejection reporting after the pending counter observes the native operation. Synchronous constructors remain unchanged. `scripts/native-wasm-lifetime.test.ts` holds each asynchronous operation open and checks that the host's pending count stays positive until settlement.
