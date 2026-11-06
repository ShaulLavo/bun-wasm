# Terminal inheritance through base programs

Classification: original host adapter. No upstream implementation is copied.

`web/src/preview1-worker.ts` selects an app-owned executor when the shell supplies
Waffle terminal metadata. `preview1-executor.ts` attaches the same terminal used
by Bun, resolves inherited terminal descriptors, passes its context and input
buffer to children, and releases its own attachment on exit. Plain noninteractive
workers retain Waffle's `preview1Executor` and do not load terminal code.

The reference is Waffle 0.0.110's public `WorkerExecutor` hooks and
`browser/runtime-terminals` API. No Waffle source or contract changes are needed.

Previously the playground launched base programs through Waffle's plain Preview1
worker. `/usr/bin/env` received a terminal descriptor but imported its default EOF
input and omitted terminal metadata from its child. Vite's `#!/usr/bin/env node`
entry then received EOF and closed its HTTP server immediately after listening.
Direct `bun run` children already inherited their live terminal correctly.

The source tests cover empty-open input, metadata inheritance, and child input
after the parent attachment closes. The browser regression exercises `env` and
a shebang through the real shell and Bun worker. Vite acceptance checks development
rendering, React state-preserving hot updates without navigation, and built preview.
