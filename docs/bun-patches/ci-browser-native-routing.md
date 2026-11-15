## Browser and native CI routing

`scripts/ci-check-inputs.ts` and `scripts/ci-changes.ts` are original bun-wasm host
tooling, with no adapted upstream implementation or upstream revision.

The immutable check-manifest reader accepts an optional family filter. It keeps
ordinary split Browser declarations separate from native correctness and shared
profiles, after validating every snapshot manifest. Existing callers retain the
unfiltered input set.

`selectChanges` reads verified base, head and merge-ancestor declarations.
Ordinary Browser inputs select fresh production through `browser_guest`;
independent native, JSC and shared causes retain native ownership through `rust`.
Non-PR events use the full route whenever Browser production is needed.
Provider admission derives this policy without changing the native correctness
flag. Coverage selection adds its production need only to `browser_guest` and
adds actual selected JSC rows only to `jsc`.
The cumulative main coverage accumulator unions both families and accepts only
its current coverage marker.

The native jobs and the PR-only Browser producer share pinned setup, optional
Cargo seeds, and the existing guest production entrypoints through composite
actions. Checkpoint preparation imports only its authenticated same-run native
handoff and runs TLS before production. Seed preparation synchronizes upstream
sources and codegen itself, verifies JSC backing, and fetches the pinned Rust
standard-library dependencies. Seeds grant no check credit. The alternate reader
uses the existing `rust` object and release namespaces. Cache writers remain
main-only and keep their existing namespaces.

The full route keeps native checks and original exports. The Browser-only route
keeps the common core, QuickJS and SpiderMonkey pairs, standard Browser and tools,
the shell and env guests, Web guest checks, and current-source site and Processes
artifacts. Consumer joins and the aggregate require exactly the selected
successful producer and an unused skipped producer. Generic Processes checks
remain source-only when neither family is selected. Release and public deploy
verification is unchanged.

## Classification

| Source | Class | Reason |
| --- | --- | --- |
| `scripts/ci-check-inputs.ts`, `scripts/ci-changes.ts`, `scripts/ci-check-inputs.test.ts`, `scripts/ci-production-separation.test.ts`, `.github/actions/native-*/action.yml` | Host feature | Original CI family routing and immutable-snapshot controls. |

[Ledger scope and pinned revisions](scope.md).

## Coverage composition

The coverage adapter adds selected browser production and selected JSC rows to the
workflow outputs without changing independent native correctness. Both providers
receive the owner/engine selection. The shared site's production step builds the
optional interruption bundle once, before either provider uploads the site.

Cumulative main selection v3 uses the existing first-parent accumulator and one
verified manifest reader for both native and browser selection. It caches each
commit's parsed declarations, unions actual owner/engine selections on every edge,
and carries that result to the batch adapter. Edited-and-reverted inputs and
intermediate removed declarations remain selected. A failed lookup still selects
all families and owners. The new marker prevents an earlier native-only successful
run from establishing browser coverage. Ready PRs keep their ordinary comparison.

The three shared native action paths explicitly select their native, JSC, shared
and ordinary browser consumers, including all serialized browser declarations.
The checker cache retains its original host/native identities through the shared
setup outputs, with its original binary path and main-only writer.
