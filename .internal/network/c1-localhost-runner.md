# C1 localhost runner

Status: Approved source wiring. Execution is blocked on an admitted Bun C1 packet.
Base: PR 454 at `733b40d5952dea027edf901f7a1147084bf38418`.
Runtime 109, relay 109, programs 15, host interface 1, and the base's Bash selection stay unchanged.

## Source entry and fixtures

- `web/tests/c1-relay-localhost.ts` admits the supplied publication packet before any source bundle, native import, service, token or listener setup. It uses `snapshotPublicationInputs` and `acceptedPublicationArtifact`, including the existing completed three-browser publication report. It creates no admission format or receipts.
- `web/tests/c1-relay-page.ts` runs the actual selected Bun guest through `startRun`, then the owner's qualified plain Preview 1 guest on fd 3 through Bun's manual launcher. This is Bun adapter evidence only. The network owner separately owns generic Waffle outside-echo proof, independently of Bun admission. It uses the released relay selection code unchanged. Carrier observations happen only after `connect` resolves, including the ready, stream and open-header exchange. An automatic WebSocket fallback is a valid reported outcome, not a claim of WebTransport support. There is no harness-level connection retry or replay.
- `web/tests/fixtures/c1-relay/guests.ts` has P1's `pg` `ssl: false` `SELECT 1` query and the no-relay loopback HTTP plus external `ENOTSUP` control.
- The owner supplies the already-qualified plain Preview 1 fd 3 echo fixture. This runner accepts its exact bytes, SHA-256, byte count, destination and expected stdout. It never compiles or creates a generic Waffle proof guest. `web/tests/c1-runner-preview1.test.ts` exercises the actual Bun `startRun` path with a fake worker, including `request.network`, transferred port, shared ring, and owner disposal after exit or post failure.
- `web/tests/c1-relay-services.ts` owns an explicit disposable Postgres container, native line echo, and released native WT plus WS relay. All listeners bind to `127.0.0.1`. Relay policy has only the exact page Origin and the two fixture destinations. There is no issuer, wildcard, proxy, gateway, Origin stripping, browser flag or trust override.

The services are outside the guest's virtual loopback, on the same execution machine. This fixture does not claim the separate different-machine outside-service finish-line evidence.

The database uses SCRAM with a generated disposable password. The password goes privately from the fixture process to the page, then into the guest's ordinary `PGPASSWORD` environment. Both page and query reject a missing value. It is not printed, placed on command argv, persisted in a file, or included in results. Relay tokens, relay endpoint, functions, helpers and streams stay in page ownership. A worker-boundary assertion rejects relay configuration and capability transfer. The Preview 1 payload remains ring, port, and socket descriptors only.

## Source-only checks available now

Run from this exclusive checkout, with frozen installed dependencies and no lifecycle scripts:

```sh
source env.sh
bun test web/tests/c1-relay-localhost.test.ts web/tests/c1-runner-preview1.test.ts web/tests/bun-launcher.test.ts web/tests/network-consumer.test.ts
./node_modules/.bin/tsc -p web/tsconfig.quality.json --pretty false
./node_modules/.bin/oxlint --deny-warnings web/tests/c1-*.ts web/tests/fixtures/c1-relay/*.ts
git diff --check
```

Do not run `--serve`, build guests, install the native relay peers, or boot any browser/device until the parent admits a new packet and authorizes execution. The runtime 107 successor's hook-smoke result is not publication admission. Do not use raw stopped candidates or P1's retired custody checker/payload hold.

## Commands for a later authorized run

PC requirements: current Bun, Node 22.18 or newer for the released native dependency, the unchanged frozen consumer installations, rootless Podman with a pre-existing Postgres 16 image, and the relay's verified exact 1.6.11 native dependency pair. No downloads, image pulls, native preparation, browser installs or guest builds happen in this runner. Public mode never starts local services or mints a token as a substitute. Stage an isolated `pg@8.16.3` dependency tree separately. Only that package and its dependency closure are copied into run scratch.

Mac requirements: the same inputs and native darwin-arm64 pair, a working already-configured Podman machine with localhost port forwarding, plus actual Safari and an iOS Simulator for their authorized runs. If these prerequisites are absent, stop and return that requirement to the parent. Do not replace Safari with Playwright WebKit or the simulator with a physical-phone claim.

The parent supplies these paths from its admitted packet, never by reconstructing a receipt:

```sh
source env.sh
export C1_GUEST_DIRECTORY=/absolute/path/to/admitted/publication-matrix
export C1_GUEST_DESCRIPTOR=/absolute/path/to/admitted/guest-descriptor.json
export C1_PUBLICATION_REPORT=/absolute/path/to/passed/publication-report.json
export C1_PG_NODE_MODULES=/absolute/path/to/isolated/pg-8.16.3/node_modules
export C1_PREVIEW1_FIXTURE=/absolute/path/to/owner-qualified/plain-echo.wasm
export C1_PREVIEW1_SHA256=OWNER_SUPPLIED_EXACT_SHA256
export C1_PREVIEW1_BYTES=OWNER_SUPPLIED_EXACT_BYTE_COUNT
export C1_PREVIEW1_HOST=OWNER_SUPPLIED_OUTSIDE_ECHO_HOST
export C1_PREVIEW1_PORT=OWNER_SUPPLIED_OUTSIDE_ECHO_PORT
export C1_PREVIEW1_STDOUT=$'OWNER_SUPPLIED_EXACT_STDOUT\n'
export C1_TOPOLOGY=localhost
export NETWORK_SCRATCH_ROOT=/work/tmp
bun web/tests/c1-relay-localhost.ts --preflight
bun web/tests/c1-relay-localhost.ts --serve
```

On the Mac, `NETWORK_SCRATCH_ROOT` must be an existing writable Mac data directory, for example `$HOME/tmp`. Copy or stage the complete admitted packet and source fixture there. Run the page and relay process on that Mac, not the PC. The default page is `http://127.0.0.1:43829/`, relay `http://127.0.0.1:43830/`, WT UDP 4433, and database host port 45432. Override only with distinct unprivileged `C1_PAGE_PORT`, `C1_RELAY_PORT`, `C1_WT_PORT`, `C1_PG_PORT`. `C1_PG_IMAGE` may name an already-present Postgres 16 image. No host or Origin override exists.

A `--serve` invocation waits for one operator-owned browser page, runs automatic selection, forced WS, then no-relay control, and exits after results and teardown. Start a fresh invocation for each browser. The fixture launches no browser itself. Use the existing browser ownership tools to create and close a task-owned Chrome or Firefox tab on PC. On Mac use actual macOS Safari and an operator-owned browser session, preserving the owner's windows. For iOS Simulator, call `device_list`, `device_open` and the returned `agent-device` command, then `device_screenshot`. Do not boot or drive a simulator with shell or SSH commands. Page and relay remain on Mac localhost for both Mac cases.

`SIGINT`, `SIGTERM`, a ten-minute deadline, and browser cancellation all reach teardown. The page polls `/control`, kills its runs, awaits their outcomes, disposes runtime-owned helpers and Preview 1 owner, and awaits relay closure. The host waits for page cleanup acknowledgement, then awaits page listener, relay, echo, container and scratch cleanup in reverse ownership order. Missing acknowledgement or failed stop is a cleanup failure, never acceptance. The operator remains responsible for closing its own browser tab/session or simulator session.

## Remaining gates

No Bun C1 guest packet is admitted today. The owner-qualified plain fixture, its exact identity, fd 3 outside-echo destination and stdout contract are also required inputs, not guessed or generated by this lane. The separate three-web/tests publication correction is outside this diff. Parent integration must rerun source checks after that correction, then use its actual accepted packet. Source tests are not full-stage receipts or network/device evidence.

The public `bun.sprockt.dev` site and its Origin are untouched. The exact new public relay hostname is `waffle-relay-public.sprockt.dev`, and the exact demo Origin is `https://waffle-network.sprockt.dev`. Neither is live or qualified. `C1_TOPOLOGY=public` fails closed before setup and never falls back to localhost. The network owner alone handles public Brine relay/container/DNS/signing policy and the qualified endpoint, allowed destination and page-owned token contract. Those are blockers for public execution, not grant requests or a parallel deployment assignment.

Physical iPhone proof later uses that owner-coordinated public Brine/VPS deployment. This localhost fixture, a private relay, generic Waffle evidence and simulator evidence cannot substitute for it. Copying or publishing any public demo artifact also waits on the owner's coordinated handoff.
