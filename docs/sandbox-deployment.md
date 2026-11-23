# Deploy the owner's sandbox

The existing Cloudflare Worker `bun-wasm` serves the sandbox at
https://bun.sprockt.dev/ and the terminal playground at `/playground/`.
Deploy merged main whenever a framework template lands, even when that framework
does not run successfully yet.

Use a clean checkout of current `origin/main`. From the repository root:

```sh
source env.sh
bun scripts/ci-install.ts --frozen-lockfile --ignore-scripts
(cd web && bun ../scripts/ci-install.ts --frozen-lockfile)
(cd sandbox && bun ../scripts/ci-install.ts --frozen-lockfile)
(cd site && bun ../scripts/ci-install.ts --frozen-lockfile)
```

Prepare the Browser, QuickJS, JSC and tools guests using the commands in
[development](development.md). Each guest needs its adjacent build receipt and
any engine side modules. Existing qualified guests can be selected with absolute
`BUN_BROWSER_WASM`, `BUN_WASM`, `JSC_WASM` and `BUN_TOOLS_WASM` paths. The
[site preflight](guest-build-receipts.md#site-publication-builds) rejects stale
embedded runtime files.

`site/build.ts` also requires `SHARED_QUICKJS_PROGRAM` and `SHARED_JSC_PROGRAM`, the
shared-group programs that worker templates use. Build them against a shared-PIC
sysroot (`bun scripts/build-wasi-sysroot.ts --shared-pic` with `BUN_WASM_SYSROOT`
pointing at it), then run `bun scripts/build-native-profile.ts shared-group OUT ENGINE`
once per engine; JSC also needs `JSC_PROFILE=shared-group bash scripts/build-jsc.sh`
first. Point each variable at the program directory the producer writes: QuickJS
lands in `OUT/program`, JSC in `OUT/program-jsc`.

Run the preflight before the build:

```sh
bun scripts/site-guest-preflight.ts
bun test web/tests/sandbox-template.test.ts
(cd site && bun run build && bun run wrangler deploy --dry-run)
```

With Cloudflare authentication available to the pinned Wrangler, publish:

```sh
(cd site && bun run deploy)
```

This command builds both apps and the pinned shell guests, deploys the existing
Worker and domain, and waits for the ordinary live URLs to match the local build.
It checks both template catalogs and engine manifests as well as the page and
worker files. Run builds through the execution host's normal build scheduler.

The sandbox picker and template payload build use
`sandbox/src/template-catalog.ts`, which includes every entry from
`web/src/playground/project-templates.ts`. Adding a shared template therefore adds
it to both apps on the next deployment. The template tests check inclusion and
that each entry exports a valid project with its initial editor file.

After publishing, inspect `/deployment.json` for the source commit, installed
Waffle version and picker entries. Open every template with
`/?template=<id>&engine=browser` and record project opening separately from dev
server startup and preview rendering. Framework failures do not remove entries
or block publishing the sandbox.

Then run the iPhone smoke's three cells against the live site in Chrome for Testing:

```sh
bun scripts/chrome-live-smoke.ts --output=/work/tmp/bun-wasm-chrome-live
```

It reads `/deployment.json`, writes each cell's log and `result.json`, and exits 0 only
when startup, install, dev, render, click and cleanup pass in every cell. Hot reload,
build and preview are recorded but not judged. `--base-url` checks another origin.

Program WASM files under `programs/` (the bash-web shell and env guests and Waffle's
base programs) ship with `.br` and `.gz` twins. The Worker (`site/worker.ts`) and
`web/serve.ts` pick one by `Accept-Encoding` and send it with a native
`Content-Encoding`, so the browser downloads the smaller file at the ordinary URL.

To inspect the current deployment or restore a previous version:

```sh
(cd site && bun run wrangler deployments list)
(cd site && bun run wrangler rollback <previous-version-id>)
```
