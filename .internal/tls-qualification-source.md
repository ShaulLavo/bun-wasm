# Early browser PostgreSQL TLS source

Status: Approved source unit. Not a TLS application pass, producer grant, or byte admission.

`scripts/tls-qualification.ts` implements `pg-early` on Chromium as a consumer of the C1 controller's sealed delivery. Its only trust input is the controller's handoff, pinned by its bytes. No paths come from CURRENT. Nothing is built at qualification time; no guest build, pin change, C1 source copy, public route, or deployment occurs.

## Input contract

The controller contract in `scripts/c1/contract.ts`, `scripts/c1/delivery.ts`, `scripts/c1/tls-page.ts` and `scripts/c1/loaded.ts` is authoritative. TLS uses its exported parsers, checks and types and keeps no copy of their schemas, role lists, modes or fixture fields.

- `--handoff` and `--handoff-sha256` name and pin the controller's `bun-wasm.c1-handoff/1` record. The pinned bytes bind the parent intake hash, the selected source and the fixture choices. TLS parses the handoff strictly, then re-derives it and requires exact equality.
- `--output` must be exactly `<handoff.outputs.tls>/pg-early`. It is created fresh; an existing directory refuses.

Preflight, in order, before any setup:

1. The handoff bytes must have the pinned SHA-256.
2. `readSealedDelivery` on the handoff's delivery root: closed member set, hashes, registry completeness, sealed modes for every member and directory (registry executables 0555, other files 0444, directories 0555). TLS never chmods, repairs or writes the sealed delivery; a 0444 launcher is a refusal.
3. The delivery's source must equal the handoff's. Its tuple must be exactly `tlsReleaseTuple`: runtime 0.0.110, relay 0.0.109, `programs-v0.0.15`, `waffle-program-release/2`, host interface 1. Older tuples, including the runtime107 packet, runtime109/relay109 and the pre-TLS unit6 source `ffbccf9a`, cannot pass.
4. `admitIntake` with the intake hash the pinned handoff names: same root, `DELIVERY.json` bytes, source, tuple and member count.
5. The sealed `inputs/CONFIG.json` and `inputs/INPUTS.json` members must have exactly the digests `DELIVERY.json` binds, and parse with `parseConfig` and `parseInputManifest`. The config must place the delivery at `roots.run.artifact/delivery` and name exactly those input bytes. The inputs must select the delivery's source and tuple.
6. `buildHandoff` from the delivery, the admitted intake, the sealed inputs' consumer dependencies, the sealed config's fixture choices and its qualification roots must equal the supplied handoff exactly. Every role, including the TLS page roles, therefore resolves to its registry member under this delivery. Every dependency and fixture claim comes from authenticated sealed records. `requireHandoffArtifacts` then rechecks role bytes and modes.
7. `--output` must be the handoff's `pg-early` directory. `fixtures.tls` must be resolved; otherwise the run stops with `TLS_EXISTING_INPUT_CONTRACT_MISSING`. The database machine, addresses and ports come only from it.
8. Before/after/preseal custody snapshots must be identical sealed members. Delivered runtime and relay archives must equal the authenticated input archives. `split/web/engine-builds.json` must pass `verifyPublicationBuilds`.
9. The Playwright browser tree must equal its authenticated identity.
10. `consumers.tls` must be resolved. Otherwise the run stops with `TLS_EXISTING_INPUT_CONTRACT_MISSING`. The pg project's `package.json` and `bun.lock` sit beside its `node_modules`, and each matches its identity. The `node_modules` tree contains only ordinary files and matches its complete tree identity. Every member of the pinned public pg 8.16.3 tarball equals the installed `pg` package, which has no extra files. Absent inputs also report `TLS_EXISTING_INPUT_CONTRACT_MISSING`.
11. The host is the sealed config's `sourceRoot`. It must be a clean checkout of the handoff's source that tracks the relay, runner and frozen package files. Its `node_modules` and `web/node_modules` must match the authenticated `rootDependencies` and `webDependencies` donors through the controller's `requireStagedDonor`. Each donor must have been installed from the source's own frozen `package.json` and `bun.lock`. Installed `waffle` must be 0.0.110 and `waffle-relay` 0.0.109; versions are only a consistency check after the bytes pass.
12. The controller's `verifyTlsPage` checks the sealed page against its receipt, this source, its bundled inputs and its resolved relay import. Only the sealed members under `handoff.tlsPageRoot` are served.

Served routes: `/` and page files from the sealed page members; `/artifact/<sha>` only for the selected guest roles (`browserGuest`; `quickjsGuest` with `quickjsSide`; `jscGuest` with `jscSide`); `/seed` and `/seed/node_modules/...` only from the preflighted pg tree; `/pg-client.ts` from `tlsPgClient`. Every served file is rechecked against its identity immediately before the response. Authenticated pg and host trees and frozen locks are rechecked before setup, before dynamic relay module loading, and before the browser starts.

## Result layout

`<handoff.outputs.tls>/pg-early/` holds `resources.before.json`, `resources.created.json`, `cleanup.json` and `result.json`. `result.json` has a top-level `loaded` array of the controller's `LoadedObservation` rows. Each row is one real GET 200 response the page or its workers received, from Playwright's context response events: URL, method, status, Content-Encoding and the SHA-256 and size of the decoded body. Before writing, TLS validates them with `parseLoaded` and `bindLoaded(handoff, "tls", rows)`. Other GET responses are kept in `unloaded` with URL and status. POST control responses are never read. The result also retains the exact identities of the handoff file, intake, `DELIVERY.json`, sealed config and inputs, source archive, page receipt, pg client, nine custody snapshots, pg archive, frozen locks, host trees and sealed page members. Results above 256 KiB fail rather than truncate provenance.

## Future command

Run only after controller production and independent parent byte intake. The controller runs it from the config's source root:

```sh
bun scripts/tls-qualification.ts \
  --stage pg-early --browser chromium --engine browser \
  --handoff "$QUALIFY_OUTPUT/handoff.json" --handoff-sha256 "$HANDOFF_SHA256" \
  --output "$QUALIFY_OUTPUT/tls/pg-early"
```

The page and relay run together on `127.0.0.1` on the handoff's page and relay ports. PostgreSQL runs as the remote Mesh user's private native process on a separately approved fleet host. That host needs writable `/work/tmp`, Bun, OpenSSL, `initdb`, `postgres`, and `pg_isready` on its command path. Ports 45433 and 45434 must be free. No container or image is created. The database and page machines need their existing fleet reservation and runner qualification before this command.

## What the fixture checks

The guest runs ordinary unmodified pg through `startRun`. Positive and TLS failure clients use literal `ssl: true`. The plaintext control alone uses `ssl: false`. The generated CA enters the guest filesystem and `NODE_EXTRA_CA_CERTS` before process start. It is absent in a fresh runtime for the no-extra-CA control.

The successful query reads `pg_stat_ssl WHERE pid=pg_backend_pid()` and requires `ssl`, matching backend PID, TLS 1.2 or 1.3, and a cipher of at least 128 bits. Separate fresh-process cases check missing extra CA, wrong hostname, SSLRequest rejection, and PostgreSQL's rejection of plaintext authentication.

The relay uses `waffle-relay/node`, with exact loopback origin, fresh signed token, and three exact logical destination entries. Each maps to the run-owned raw proxy. There is no TLS option on the relay. The page forces the WebSocket carrier and checks one real connection per case. Existing host fetch selection remains unchanged.

The raw proxy retains only bounded protocol headers and counters. It rejects raw startup bytes on TLS paths and any byte after an SSLRequest rejection. A separate native TLS destination uses the generated server certificate for the trust-failure cases and counts decrypted startup bytes. Its actual endpoint must first observe a known native TLS positive control. Trust-failure cases require zero plaintext bytes after physical connection drain. This native TLS control is not a pg query or a substitute for the browser guest.

This early runner does not establish public bundled roots, expired/not-yet-valid certificates, HTTPS/WSS breadth, the entire three-engine fixture matrix, or successful-client internal verification-event ordering. The PR 3 native/client tests and reviewed source still own that internal barrier. The result must not be described as full G1 or final TLS acceptance on its own.

## Ownership and cleanup

Preflight completes before directories, keys, database processes, relay, or browser creation. Cancellation is checked before validation, immediately after validation, and before every acquisition. Owners register release before acquiring a process, listener, runtime, relay, browser, context, page, or guest. A resource returned after cancellation still belongs to that release. The owned cleanup stack closes page consumers, Chromium, the page server, relay, raw sockets, and remote native fixtures/PostgreSQL in reverse order. Chromium uses the controller's `TMPDIR`, which the controller requires to be empty afterwards. Remote scratch removal is checked on the actual database host. Per-case lifecycle data comes from the actual runtime `disposed` getter, the retained-consumer lease registrations used by the real runner and C1 adapter, and the native relay server's actual TCP active count. Both cleanup callbacks must resolve and those observations must show zero remaining leases and relay connections. Old completion booleans alone are rejected. Filesystem absence and child exits retain their actual error/status observations. Only bounded redacted results and resource ledgers remain. Credentials, keys, decrypted payloads, and guest stderr are not logged.

Source tests build a synthetic sealed delivery, intake and handoff with the controller's own `writeFixtureDelivery`, `fixtureInputManifest`, `prepareTlsPage` (with a synthetic page builder, never `Bun.build`), `sealDelivery` and `buildHandoff`. They add a clean synthetic host checkout and donor and pg trees. They are parser fixtures, never product evidence. They assert that an exact pinned handoff reaches setup without changing sealed metadata. Wrong pin, output, schema, fixture options, page, root, source, tuple, manifest, count, role, path, mode, hash, dependency and custody, tampered handoffs, and missing requirements must all fail before setup. Loaded observations are checked with the controller's validator. Each fixture removes its own sealed directories after the test by making them writable only to delete them. `TLS_SOURCE_RESOURCE_LEDGER` records creation and confirmed absence.

## Integration prerequisites

The controller's TLS driver passes `--output <outputs.tls>/pg-early` but records its `DriverRun.out` as `outputs.tls`, and `runConsumer` reads `DriverRun.out/result.json`. TLS writes `result.json` only to its `--output` directory. Until the controller aligns `out` with that directory, the controller will not find the TLS result. TLS does not write a second copy.

The native TLS driver and exposed JS client are separate reviewed work. Their exact integrated source must enter the sole producer and independent parent intake before any live command. Its first authorized live run must validate the remote native fixture, carrier, package preparation, teardown, and verification barrier. Missing functionality remains a failure, never a passing stub.
