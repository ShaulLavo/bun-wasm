# Early browser PostgreSQL TLS source

Status: Approved source unit. Not a TLS application pass, producer grant, or byte admission.

`scripts/tls-qualification.ts` implements `pg-early` on Chromium. It requires an explicitly reviewed TLS source head and tree, pinned delivery and parent intake hashes, and the pinned source-release hash. No paths come from CURRENT. No guest build, pin change, C1 source copy, public route, or deployment occurs.

## Input contract

`--delivery` is the complete immutable delivery directory containing `DELIVERY.json` and `inputs/ADMISSION.json`. The semantic producer contract is `bun-wasm.complete-producer-delivery.v2`. The existing outer manifest has `source`, `files`, and `nativeBacking`, rather than a manufactured schema or TLS-ready flag. The runner reuses `requireCompletePublicationFiles`, `verifyPublicationBuilds`, and `verifyPublicationNativeBacking`.

`--admission` is Next's `independent-parent-byte-admission`, owned by `mcp:e5ea79c9-80ba-4f6e-b71a-4886c114af80`. It must independently admit the same delivery root and exact source. Its existing reference objects bind `deliveryManifest`, `producerAdmission`, `sourceRelease`, `canonicalReuse`, and `sourceArchive` by absolute path, byte count, and SHA-256. Its byte-intake and before/after/preseal custody checks remain required. The runner rehashes the complete inventory, rejects extra files and links, rechecks canonical original bytes, and compares the three custody snapshots with the parent's identities.

The explicit expected TLS head/tree and source-release hash are trust inputs supplied after independent source review. They are never inferred from a package version or a boolean. The intake tuple must explicitly select runtime and relay 0.0.109, host interface 1, and QuickJS/JSC/browser. The old runtime107 packet cannot pass.

`--host-source` is a clean checkout of that same reviewed head/tree, with the real C1 `web/src/net/relay.ts`, runner, workers, and normal browser builder. Installed `waffle` and `waffle-relay` must both be 0.0.109. The page bundles these real source files. It does not copy C1 implementations or install dependencies.

`--pg-node-modules` is a separate, ordinary-file installation containing pg 8.16.3 and its dependencies. `--pg-tarball` and `--pg-tarball-sha256` pin the independently checked public pg 8.16.3 tarball. The runner compares every pg package file and rejects additions, changes, missing members, and links. It never changes repository pins or locks. Dependency and emitted host bundle identities are retained in the result.

## Future command

Run only after parent-reviewed production and independent byte intake. All path variables below must name real supplied inputs.

```sh
source env.sh
bun scripts/tls-qualification.ts \
  --stage pg-early --browser chromium --engine browser \
  --delivery "$TLS_DELIVERY" --delivery-sha256 "$TLS_DELIVERY_SHA256" \
  --admission "$TLS_ADMISSION" --admission-sha256 "$TLS_ADMISSION_SHA256" \
  --source-release-sha256 "$TLS_SOURCE_RELEASE_SHA256" \
  --reviewed-head "$TLS_REVIEWED_HEAD" --reviewed-tree "$TLS_REVIEWED_TREE" \
  --host-source "$TLS_HOST_SOURCE" \
  --pg-node-modules "$TLS_PG_NODE_MODULES" \
  --pg-tarball "$TLS_PG_TARBALL" --pg-tarball-sha256 "$TLS_PG_TARBALL_SHA256" \
  --database-machine "$TLS_DATABASE_MACHINE" \
  --database-address "$TLS_DATABASE_ADDRESS" --relay-address "$TLS_RELAY_ADDRESS" \
  --output "$TLS_RESULTS/pg-early"
```

The page and relay run together on `127.0.0.1`, ports 43839 and 43840 by default. `--page-port` and `--relay-port` override them explicitly. PostgreSQL runs as the remote Mesh user's private native process on a separately approved fleet host. That host needs writable `/work/tmp`, Bun, OpenSSL, `initdb`, `postgres`, and `pg_isready` on its command path. Ports 45433 and 45434 must be free. No container or image is created. The database and page machines need their existing fleet reservation and runner qualification before this command.

## What the fixture checks

The guest runs ordinary unmodified pg through `startRun`. Positive and TLS failure clients use literal `ssl: true`. The plaintext control alone uses `ssl: false`. The generated CA enters the guest filesystem and `NODE_EXTRA_CA_CERTS` before process start. It is absent in a fresh runtime for the no-extra-CA control.

The successful query reads `pg_stat_ssl WHERE pid=pg_backend_pid()` and requires `ssl`, matching backend PID, TLS 1.2 or 1.3, and a cipher of at least 128 bits. Separate fresh-process cases check missing extra CA, wrong hostname, SSLRequest rejection, and PostgreSQL's rejection of plaintext authentication.

The relay uses `waffle-relay/node`, with exact loopback origin, fresh signed token, and three exact logical destination entries. Each maps to the run-owned raw proxy. There is no TLS option on the relay. The page forces the WebSocket carrier and checks one real connection per case. Existing host fetch selection remains unchanged.

The raw proxy retains only bounded protocol headers and counters. It rejects raw startup bytes on TLS paths and any byte after an SSLRequest rejection. A separate native TLS destination uses the generated server certificate for the trust-failure cases and counts decrypted startup bytes. Its actual endpoint must first observe a known native TLS positive control. Trust-failure cases require zero plaintext bytes after physical connection drain. This native TLS control is not a pg query or a substitute for the browser guest.

This early runner does not establish public bundled roots, expired/not-yet-valid certificates, HTTPS/WSS breadth, the entire three-engine fixture matrix, or successful-client internal verification-event ordering. The PR 3 native/client tests and reviewed source still own that internal barrier. The result must not be described as full G1 or final TLS acceptance on its own.

## Ownership and cleanup

Preflight completes before directories, page builds, keys, database processes, relay, or browser creation. An owned cleanup stack closes page consumers, Chromium, the page server, relay, raw sockets, remote native fixtures/PostgreSQL, and local scratch in reverse order. Remote scratch removal is checked on the actual database host. Only bounded redacted results and resource ledgers remain. Credentials, keys, decrypted payloads, and guest stderr are not logged.

Source tests use tiny parser-only bytes. They assert that invalid evidence never calls setup, that source/hash/custody mismatches fail, that query/carrier/engine context is mandatory, and that teardown runs after setup and exercise failure. They do not create an admitted artifact.

## Integration prerequisites

The foundation still selects runtime107 and has no C1 relay source file. Its canonical complete-publication helper still names `inputs/runtime107-release.tgz`. Engines and Next must supply the real reviewed runtime109 complete-delivery contract and matching host checkout. This unit neither renames a 107 file to 109 nor relaxes the canonical closure helper.

The native TLS driver and exposed JS client are separate reviewed work. Their exact integrated source must enter the sole producer and independent parent intake before any live command. The future lifecycle and browser code here has only source tests, types, and lint in this task. Its first authorized live run must validate the remote native fixture, carrier, package preparation, teardown, and verification barrier. Missing functionality remains a failure, never a passing stub.
