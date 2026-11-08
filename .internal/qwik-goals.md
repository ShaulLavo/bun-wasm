# Qwik goal cells

Status: Approved. Implementation and acceptance verification are in progress.

The browser host now counts native asynchronous WebAssembly operations so Qwik's optimizer initialization can finish before process exit. The CSR starter preserves its render call, loads Qwik's delegated events and uses Vite's static production preview without SSR middleware. Failing-first coverage lives in `scripts/native-wasm-lifetime.test.ts` and `scripts/qwik-starter.test.ts`.

Acceptance requires development rendering, click, file-edit hot reload, production build and preview on Chrome and Firefox for browser, QuickJS and JSC engines. The worker's evidence and exact commands are retained in `/work/reports/goals/qwik/IMPLEMENTATION.md`. Safari and iPhone report cells remain untouched by this shard. The parent coordinator owns independent review and merge.
