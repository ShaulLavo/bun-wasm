# Replay the pinned Next advisory request

The `nextRegistry(extra, port, overlay)` helper composes three read-only inputs.
Metadata and tarball GETs come from the existing app-matrix recording and `extra`.
Only advisory POSTs come from `overlay`. No cache is merged or rewritten.

The checked-in overlay is `scripts/app-matrix/fixtures/next-advisory/`.
Its `capture.json` records an explicit public npm fetch, made with an isolated home
and without npm config or credentials. The pinned NEXT-01 fixture actually sent
`POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk` with these exact
UTF-8 body bytes, with no trailing newline:

```json
{"next":["16.4.3"]}
```

The fixture lock SHA-256 is
`ac8a742d84db44e77cdfaafb1bd72d21f858964a7c0a1c7dc986fa1b4b0045e7`.
The request was observed on QuickJS in Chromium 156.0.8078.4.
The public fetch on 2026-10-29 returned HTTP 200 and two bytes, `{}`.
This is a captured historical response, not a claim about current vulnerabilities.

The index key is `POST <exact-path> <SHA-256-of-raw-body>`.
Body whitespace changes the identity. Method, path, query, and body mismatches
fail closed. Advisory requests must be JSON package/version maps and cannot
exceed 64 KiB. Responses cannot exceed 4 MiB, including on disk before loading.
Replay checks the response SHA-256 and preserves its status and body bytes,
including non-success responses. Recorder failures carry a separate error header.
Unknown POST endpoints never reach the public broker. The broker sends only
explicit Accept and Content-Type headers, never client credentials.

The existing GET index keys, tarball integrity checks, object SHA-256 checks,
and metadata tarball rewrites are unchanged. POST JSON is never metadata-rewritten.
GET cannot read a POST recording. Only the two exact public npm URLs for Next
advisories and dist-tags can be mapped by the browser guard to the local mirror.
All other external traffic remains blocked.

Call the composed replay directly:

```ts
const replay = nextRegistry(extraDirectory, 0, overlayDirectory);
// Pass replay.base to browserRegistryRoute; close replay in finally.
```

Acceptance-runner integration is a separate caller change. It must pass the
optional overlay directory and include all three index files in the recorded
registry hash and entry count. An overlay without supplemental GET replay must
be rejected by that CLI. The overlay never replaces the accepted tarball cache.

Verify without public network access:

```sh
bun test scripts/app-matrix/advisory-replay.test.ts \
  scripts/app-matrix/browser-environment.test.ts \
  scripts/app-matrix/registry.test.mjs
```

The tests include a nonempty advisory response, a non-success response, a stopped
Unix broker during replay, an upstream-fetch trap, mismatched requests, body
limits, corrupt advisory objects, and unchanged GET integrity and rewriting.
