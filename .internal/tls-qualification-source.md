# Early browser PostgreSQL TLS source

Status: Approved source unit. Not a TLS application pass, producer grant, or byte admission.

`scripts/tls-qualification.ts` implements `pg-early` on Chromium as a consumer of the C1 controller's sealed delivery. It requires the controller's consumer handoff, an independently pinned parent intake hash, and an explicitly reviewed source head and tree. No paths come from CURRENT. No guest build, pin change, C1 source copy, public route, or deployment occurs.

## Input contract

The controller contract in `scripts/c1/contract.ts` and `scripts/c1/delivery.ts` is authoritative. TLS uses its exported parsers and checks and keeps no copy of their schemas, role lists or modes.

- `--handoff` is the controller's `bun-wasm.c1-handoff/1` record. It is only a locator. TLS parses it strictly, then re-derives the handoff and requires exact equality.
- `--intake-sha256` pins the bytes of the independent parent's `bun-wasm.c1-intake/1` record named by the handoff.
- `--reviewed-head` and `--reviewed-tree` are trust inputs supplied after independent source review. They are never inferred from a package version, a record or a boolean.

Preflight, in order, before any setup:

1. `readSealedDelivery` on the handoff's delivery root: closed member set, hashes, registry completeness, sealed modes for every member and directory (registry executables 0555, other files 0444, directories 0555). TLS never chmods, repairs or writes the sealed delivery; a 0444 launcher is a refusal.
2. The delivery's source must equal the reviewed pin. Its tuple must be exactly `tlsReleaseTuple`: runtime 0.0.110, relay 0.0.109, `programs-v0.0.15`, `waffle-program-release/2`, host interface 1. Older tuples, including the runtime107 packet, runtime109/relay109 and the pre-TLS unit6 source `ffbccf9a`, cannot pass.
3. `admitIntake` with the pinned hash: same root, `DELIVERY.json` bytes, source, tuple and member count.
4. The sealed `inputs/CONFIG.json` and `inputs/INPUTS.json` members must have exactly the digests `DELIVERY.json` binds, and parse with `parseConfig` and `parseInputManifest`. The config must place the delivery at `roots.run.artifact/delivery` and name exactly those input bytes. The inputs must select the delivery's source and tuple.
5. `buildHandoff` from the delivery, the admitted intake, the sealed inputs' consumer dependencies and the sealed config's qualification roots must equal the supplied handoff exactly. Every role therefore resolves to its registry member identity under this delivery, and every dependency claim comes from authenticated inputs. `requireHandoffArtifacts` then rechecks role bytes and modes.
6. Before/after/preseal custody snapshots must be identical sealed members. Delivered runtime and relay archives must equal the authenticated input archives. `split/web/engine-builds.json` must pass `verifyPublicationBuilds`.
7. The Playwright browser tree must equal its authenticated identity.
8. `consumers.tls` must be resolved. Otherwise the run stops with `TLS_EXISTING_INPUT_CONTRACT_MISSING`. The pg project's `package.json` and `bun.lock` sit beside its `node_modules`, and each matches its identity. The `node_modules` tree contains only ordinary files and matches its complete tree identity. Every member of the pinned public pg 8.16.3 tarball equals the installed `pg` package, which has no extra files. Absent inputs also report `TLS_EXISTING_INPUT_CONTRACT_MISSING`.
9. The host is the sealed config's `sourceRoot`. It must be a clean checkout of the reviewed head and tree that tracks the relay, runner and frozen package files. Its `node_modules` and `web/node_modules` must match the authenticated `rootDependencies` and `webDependencies` donors through the controller's `requireStagedDonor`. Each donor must have been installed from the source's own frozen `package.json` and `bun.lock`. Installed `waffle` must be 0.0.110 and `waffle-relay` 0.0.109; versions are only a consistency check after the bytes pass.

Guest bytes come from handoff roles (`browserGuest`; `quickjsGuest` with `quickjsSide`; `jscGuest` with `jscSide`) and are served from their sealed paths after a byte recheck. Authenticated pg and host trees and frozen locks are rechecked before setup, dynamic module loading and browser build. Seeded pg files are checked again immediately before the response that copies them into the guest. The bounded result retains these exact identities: the handoff file, intake, `DELIVERY.json`, sealed config and inputs, source archive, nine custody snapshots, pg archive, frozen locks, host trees and emitted host bundle files. Results above 256 KiB fail rather than truncate provenance. Output goes to the handoff's own `outputs.tls` directory.

## Future command

Run only after controller production, independent parent byte intake and the amended controller interface below.

```sh
source env.sh
bun scripts/tls-qualification.ts \
  --stage pg-early --browser chromium --engine browser \
  --handoff "$TLS_HANDOFF" --intake-sha256 "$TLS_INTAKE_SHA256" \
  --reviewed-head "$TLS_REVIEWED_HEAD" --reviewed-tree "$TLS_REVIEWED_TREE" \
  --database-machine "$TLS_DATABASE_MACHINE" \
  --database-address "$TLS_DATABASE_ADDRESS" --relay-address "$TLS_RELAY_ADDRESS"
```

The page and relay run together on `127.0.0.1`, ports 43839 and 43840 by default. `--page-port` and `--relay-port` override them explicitly. PostgreSQL runs as the remote Mesh user's private native process on a separately approved fleet host. That host needs writable `/work/tmp`, Bun, OpenSSL, `initdb`, `postgres`, and `pg_isready` on its command path. Ports 45433 and 45434 must be free. No container or image is created. The database and page machines need their existing fleet reservation and runner qualification before this command.

## What the fixture checks

The guest runs ordinary unmodified pg through `startRun`. Positive and TLS failure clients use literal `ssl: true`. The plaintext control alone uses `ssl: false`. The generated CA enters the guest filesystem and `NODE_EXTRA_CA_CERTS` before process start. It is absent in a fresh runtime for the no-extra-CA control.

The successful query reads `pg_stat_ssl WHERE pid=pg_backend_pid()` and requires `ssl`, matching backend PID, TLS 1.2 or 1.3, and a cipher of at least 128 bits. Separate fresh-process cases check missing extra CA, wrong hostname, SSLRequest rejection, and PostgreSQL's rejection of plaintext authentication.

The relay uses `waffle-relay/node`, with exact loopback origin, fresh signed token, and three exact logical destination entries. Each maps to the run-owned raw proxy. There is no TLS option on the relay. The page forces the WebSocket carrier and checks one real connection per case. Existing host fetch selection remains unchanged.

The raw proxy retains only bounded protocol headers and counters. It rejects raw startup bytes on TLS paths and any byte after an SSLRequest rejection. A separate native TLS destination uses the generated server certificate for the trust-failure cases and counts decrypted startup bytes. Its actual endpoint must first observe a known native TLS positive control. Trust-failure cases require zero plaintext bytes after physical connection drain. This native TLS control is not a pg query or a substitute for the browser guest.

This early runner does not establish public bundled roots, expired/not-yet-valid certificates, HTTPS/WSS breadth, the entire three-engine fixture matrix, or successful-client internal verification-event ordering. The PR 3 native/client tests and reviewed source still own that internal barrier. The result must not be described as full G1 or final TLS acceptance on its own.

## Ownership and cleanup

Preflight completes before directories, page builds, keys, database processes, relay, or browser creation. Cancellation is checked before validation, immediately after validation, and before every acquisition. Owners register release before acquiring a scratch directory, process, listener, runtime, relay, browser, context, page, or guest. A resource returned after cancellation still belongs to that release. The owned cleanup stack closes page consumers, Chromium, the page server, relay, raw sockets, remote native fixtures/PostgreSQL, and local scratch in reverse order. Remote scratch removal is checked on the actual database host. Per-case lifecycle data comes from the actual runtime `disposed` getter, the retained-consumer lease registrations used by the real runner and C1 adapter, and the native relay server's actual TCP active count. Both cleanup callbacks must resolve and those observations must show zero remaining leases and relay connections. Old completion booleans alone are rejected. Filesystem absence and child exits retain their actual error/status observations. Only bounded redacted results and resource ledgers remain. Credentials, keys, decrypted payloads, and guest stderr are not logged.

Source tests build a synthetic sealed delivery, intake and handoff with the controller's own `writeFixtureDelivery`, `fixtureInputManifest`, `sealDelivery` and `buildHandoff`, plus a clean synthetic host checkout and donor and pg trees. They are parser fixtures, never product evidence. They assert that an exact handoff reaches setup without changing sealed metadata. Wrong schema, root, source, tuple, manifest, count, role, path, mode, hash, dependency, custody and tampered handoffs, and missing requirements, must all fail before setup. Each fixture removes its own sealed directories after the test by making them writable only to delete them. `TLS_SOURCE_RESOURCE_LEDGER` records creation and confirmed absence.

## Integration prerequisites

Two controller-owned interface items are open; the amended controller checkpoint owns both. TLS does not invent fields for them.

- Private database host and service options: the database machine, the database and relay addresses, and the ports are not yet in the typed config, inputs or handoff. They remain CLI flags until the amended contract carries them.
- Prebuilt page and worker assets: the page is still built at qualification time from the host checkout through `scripts/browser-build.ts`. The amended contract adds sealed preseal page and worker assets, an admitted entry and member set, and a typed loaded-bytes observation. Qualification must then serve only those sealed assets, with no build at consumer time.

The native TLS driver and exposed JS client are separate reviewed work. Their exact integrated source must enter the sole producer and independent parent intake before any live command. Its first authorized live run must validate the remote native fixture, carrier, package preparation, teardown, and verification barrier. Missing functionality remains a failure, never a passing stub.
