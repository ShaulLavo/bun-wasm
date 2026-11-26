# Bun API probe

The Bun API probe checks the Bun-native features a Bun user tries first, on every engine, against what native Bun prints. Each area is one fixture under `tests/fixtures/bun-probe-*`:

| Fixture | What it covers |
| --- | --- |
| `bun-probe-test` | `bun test`: `describe`/`test`/`expect`, hooks, `test.each`, `mock()`, `spyOn`, file and inline snapshots, `skip`/`todo`/`if`, asymmetric matchers |
| `bun-probe-serve` | `Bun.serve`: static, parameter, method, file, redirect and wildcard routes, the error handler, `ReadableStream`, async generator and direct-stream responses, WebSocket upgrade, echo and pub/sub |
| `bun-probe-sqlite` | `bun:sqlite`: prepared statements, named parameters, transactions and rollback, `.as(Class)`, `iterate`, BLOBs, bigints, file databases, `serialize`/`deserialize` |
| `bun-probe-io` | `Bun.file`, `Bun.write`, `Bun.stdin`, `Bun.spawn`/`spawnSync` and `Bun.$` (with builtins that both Bun's shell and bash-web run) |
| `bun-probe-build` | `Bun.build` (minify, splitting, define, external, sourcemaps, HTML and CSS entries) and the `bun build` CLI |
| `bun-probe-tsx` | TypeScript and JSX out of the box: enums, namespaces, decorators, `using`, `satisfies`, classic JSX pragmas, JSON and text imports |
| `bun-probe-utils` | `Bun.password`, `Bun.hash`, `Bun.CryptoHasher`, `Bun.Glob`, `Bun.semver`, `Bun.TOML`, `Bun.YAML`, `Bun.inspect`, `HTMLRewriter`, compression and more |
| `bun-probe-cli` | `bun -e`, `-p`, `run` (scripts, files, stdin), `test -t`, failing tests, `build --target=bun` |

Each fixture prints one `ok <check>: <value>` or `FAIL <check>: <error>` line per check, so a failure names itself and the other checks still run. `expected.txt` is native Bun's output (`scripts/test.sh --update`), and each fixture has a `checks/native-bun-probe-*.json` manifest that runs it on QuickJS, JavaScriptCore and the browser engine.

## In the playground

`scripts/bun-api-probe.ts` types the same fixtures into the playground in a real browser, the way a person would, compares every check with native Bun's line and prints a table per engine, with boot time and the time `bun hello.ts` takes:

```sh
bun web/build.ts                       # or point --url at a deployed playground
bun scripts/bun-api-probe.ts --engines quickjs,jsc,browser,spidermonkey --out results.json
bun scripts/bun-api-probe.ts --url https://bun.sprockt.dev/playground/ --network
```

It also runs checks the native launcher cannot: `Bun.$` with coreutils (`mkdir`, `ls`, `tr`, `rm`) and redirects, and with `--network`, `bun init`, `bun add react` with server rendering, `bunx` and `fetch` over HTTPS.

## Not supported yet

These fail with a clear error instead of wrong output, and are left out of the fixtures until they work:

- `mock.module()` in `bun test`.
- `Bun.build({ plugins })`: the bundler has no JavaScript plugin hooks.
- `Bun.markdown`, `Bun.CSRF` and `Bun.color` are not exposed.
