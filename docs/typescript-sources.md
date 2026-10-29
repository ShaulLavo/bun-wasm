# TypeScript source policy

New handwritten source is TypeScript. The blocking quality probe audits tracked and
untracked `.js`, `.mjs` and `.cjs` files. It accepts only these classes:

| Class | Paths |
| --- | --- |
| Generated output | `crates/bunwasm-build/generated/`, `crates/bunwasm-runtime/generated/`, and the generated entry files under `third_party/` named in `scripts/typescript-sources.ts` |
| Deliberate JavaScript runtime input | Exact guest, bundler, and parser inputs in `scripts/typescript-source-runtime-inputs.txt` |
| Legacy handwritten source | Exact paths in `scripts/typescript-source-legacy.txt` |

The legacy inventory covers the 24 runtime modules, the three Web host modules,
the vendored Node stream adapter and its copied dependency, and existing host-side
scripts and test helpers. It does not exempt their directories. A new helper beside
those files fails just like a new runtime module.

Runtime fixtures stay JavaScript when their extension or syntax is the behavior
under test. Add each deliberate input's exact path to the runtime-input inventory.
A module loaded by a fixture is also runtime input. Host-side helpers that launch
or inspect a test are not fixtures and belong in TypeScript, even when they live
beside genuine inputs.

Convert one legacy file by renaming it to TypeScript, adding real types, and
removing its inventory line in the same change. Deleting a legacy file also removes
its line. The checker rejects stale entries in both inventories and compares the
legacy inventory with the base revision to prevent additions. Renaming JavaScript
to another JavaScript path is not a conversion.

Run the repository audit directly or through its single registered quality owner:

```sh
bun scripts/typescript-sources.ts
bun scripts/test-checks.ts quality
```
