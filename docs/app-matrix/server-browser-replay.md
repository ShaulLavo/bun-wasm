# Replay server frameworks in a browser

Use a matching `dist/bun-browser.wasm` and a built `web/dist`.
Install root and web dependencies from their lockfiles before building the web
host. The browser guest must match the source revision being tested.

```sh
source env.sh
bun install --frozen-lockfile
(cd web && bun install --frozen-lockfile && bun run build)
```

Use an unused output directory. On the owner's PC, run the browser check through
the shared heavy runner:

```sh
bun /work/platform-production/heavy/current/run.js --class browser server-browser-replay -- \
	timeout 7200 bash scripts/app-matrix.sh --strict \
	--apps=express,koa,fastify,hono,elysia --engines=browser --hosts=playground \
	--cache=/work/cache/bun-wasm-app-matrix --timeout=90 \
	--output=/work/reports/bun-wasm-server-browser-replay
```

Expect ten passing rows, 30 request checks, and exit code zero.
`--strict` makes any failed or blocked row exit nonzero. Without that flag, the
matrix keeps its census behavior and exits nonzero only for infrastructure errors.
Do not treat a package-install pass as a server pass.

Run the matrix regression tests through a light slot:

```sh
bun /work/platform-production/heavy/current/run.js --class light server-browser-tests -- \
	timeout 7200 bun test scripts/app-matrix/*.test.ts scripts/app-matrix/*.test.mjs
```

Inspect `results.json`, `*-requests.json`, terminal logs, and screenshots in the
chosen output directory. The runner removes its temporary guest files, servers,
and browser contexts on completion or interruption. Keep the guest and web build
until other named consumers release them.

The reference evidence and scope are in
[Server framework browser coverage](server-browser.md).
