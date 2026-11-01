# C1 localhost acceptance fixtures

Classification: original consumer test adapters and runners.

The original files are `web/tests/c1-relay-inputs.ts`, `web/tests/c1-relay-localhost.ts`, `web/tests/c1-relay-page.ts`, `web/tests/c1-relay-services.ts`, `web/tests/c1-relay-localhost.test.ts`, `web/tests/c1-runner-preview1.test.ts`, and `web/tests/fixtures/c1-relay/{guests,protocol}.ts`.

They compose the existing Bun runner, publication artifact intake, page-owned relay client, Preview 1 socket bindings and released native relay. No production launcher API, upstream implementation or dependency pin changes are introduced. The Bun pg query follows the successful P1 source proof with `pg` 8.16.3, `ssl: false` and `SELECT 1`. The disposable database password is forwarded through the ordinary guest environment with explicit presence checks, while relay authorization stays page-owned. The plain Preview 1 fixture must come from the owner with its qualified byte identity and outside-echo contract. This lane creates no generic Waffle proof guest.
