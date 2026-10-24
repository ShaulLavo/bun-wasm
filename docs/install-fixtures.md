# Installer fixtures

The npm registry in `registry.mjs` serves deterministic gzip tarballs from memory. It never
forwards a request to the public registry. Its packages cover transitive dependencies,
scopes, conflicting versions, peers, missing optional dependencies, blocked lifecycle
scripts, an incorrect SHA-512 digest, path traversal and a symlink that escapes the package.
Regressions cover removing direct dependencies still needed transitively, required consumers
of optional packages, optional peers across locked installs, optional dependency precedence,
production installs with a full frozen lockfile and cyclic dependencies using dist tags.
A stalled-download test checks the configurable HTTP idle timeout in bun-wasm; the
native Bun reference skips that host bridge check.
Both runners stop their processes and registry, then remove their scratch directories.

From the repository root:

```sh
source env.sh
node tests/install/run.mjs
BUN_WASM=dist/bun-jsc.wasm node tests/install/run.mjs
INSTALL_ENGINE=browser BUN_WASM=dist/bun-browser.wasm node tests/install/run.mjs
INSTALL_NATIVE_BUN=1 node tests/install/run.mjs
```

`BUN_WASM_LAUNCHER` overrides the default launcher path.
`INSTALL_CASES` selects a comma separated subset. The native reference uses Bun's hoisted
linker, matching bun-wasm's layout. `archiveSafety` accepts rejecting an unsafe archive or
ignoring its unsafe entries, and checks that extraction writes no files outside the package.

`native-reference.json` records native Bun 1.4.2 output and the exact simple-project lockfile,
with the local server origin replaced by `REGISTRY` and elapsed time by `[TIME]`. Regenerate it:

```sh
INSTALL_NATIVE_BUN=1 INSTALL_CASES=aliases INSTALL_CAPTURE_REFERENCE=tests/install/native-reference.json node tests/install/run.mjs
```

The browser check uses the same registry on another origin and blocks external requests:

```sh
cd web
bun run build
node tests/browser-install.mjs
ENGINES=browser node tests/browser-install.mjs chromium
```

It drives the playground terminal, sets `[install].registry` in `bunfig.toml`, adds `is-odd`,
imports it, adds a scoped dev dependency, lists packages, reinstalls with the registry
offline and removes a package. Chromium and WebKit run all three engines by default.
