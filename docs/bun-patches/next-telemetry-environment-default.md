# Next telemetry environment default

Classification: original host adapter policy and regression tests. No upstream implementation is copied or patched.

`src/executable-paths.ts` supplies `NEXT_TELEMETRY_DISABLED=1` in the normal Bun environment. The page runner applies it only to Bun roots; public package adapters and Shell children use it through the Bun launcher. Caller values, including `0` and the empty string, take precedence. The launcher still reserves `PWD` and the normalized `BUNWASM_EXEC_PATH` and leaves the admitted PATH unchanged. `engineEnvironment` retains its PATH-only contract.

The default belongs to the host environment rather than a guest build or application fixture. Preview1 requests retain their caller environment. The existing Shell product fixture already supplies the same value and needs no change.

The flag disables telemetry submission. In Next 15.5.6, `dist/telemetry/storage.js` gates `submitRecord` with the disabled flag but does not gate `flushDetached`. The shutdown path can still start an independent flush child. This default does not change child-process or job ownership semantics and does not promise zero shutdown children.

`tests/package/telemetry-environment.test.ts` installs the public adapters and sends spawn requests through the real process service into a native observation worker. The worker reads the received request through the production executor environment boundary without running a guest. The tests cover root defaults, caller overrides, input immutability, reserved fields, PATH, and propagation to later Bun launches.
