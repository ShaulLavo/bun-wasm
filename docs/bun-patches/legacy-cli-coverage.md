# Legacy CLI network coverage

Classification: original test adapter. No upstream source is copied or patched.

Local source: `scripts/test-web.sh` at `0fd93cd09e99fd47ccfcdfc15987a052dafcc639`.
The seven fixture commands in both slot modes move to `scripts/legacy-cli.ts`.
The local full entrypoint and the runtime-owned manifest call that helper once.
The required native preflight discovers the runtime owner through the existing runner.

Each command still uses `web/scripts/run.ts`, the ordinary `dist/bun.wasm` and
`quickjs.wasm` pair, its fixture's source, and the 60-second hang supervisor.
The helper compares complete merged stdout/stderr as bytes and requires exit zero.
One existing `tests/servers/http.ts` server provides the loopback port for all rows.
The helper now verifies the existing guest build receipt and companion before launch,
rejects incomplete row accounting, and owns server and scratch cleanup.
It performs no build, artifact substitution, or runtime repair.

`scripts/legacy-cli.test.ts` uses an owned TypeScript consumer control and tiny
receipt fixtures to test orchestration. These controls do not establish live guest
coverage. `scripts/legacy-cli-runtime.test.ts` executes all fourteen real rows.
