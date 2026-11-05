# One C1 controller

Status: Approved design, plan checkpoint. No build, claim or production under this
document. Execution needs a separate grant after the combined plan and C1 intake.

Base: main `61a86be3741b22576b149d271e6ea87618c20e9c`, tree
`180a04fd181f22f703e6a3e9e54870eef844279d` (includes PR 470). The final product
head and tree are the actual merged controller plus Next fixture/driver source,
never this base and never a dirty overlay.

## Where things stand

Current main has no C1 controller. It has the split producer
(`scripts/engine-producer.ts`), the publication registry
(`scripts/producer-closure.ts`) and the PR458 claim guard
(`scripts/producer-start.ts`). Everything else that ran unit 6 lives only in the
unmerged control branch `5aef1f42` (13 commits on `dac56d02`): about 2,400 lines
of TypeScript, a pinned Python template rewritten by string surgery, a
repo-checked cohort inventory, a per-unit authority record and a bwrap
pre-claim proof. That branch is a donor of code and lessons only; none of its
cohort pins, unit names or template are carried over.

Unit 6 product `ffbccf9a` is not current main: main moved runtime to 0.0.110,
Waffle native source to `f1bccf55`, Bash to `fc8327a3`, the BoringSSL source
group gained `ssl`, `jsc/common.sh` changed (`write-tree --missing-ok`) and
Cargo.lock gained crates. So no unit 6 byte is a current-main candidate.

## Two whole-controller shapes

**A. One process owns one typed run (chosen).** `scripts/c1-controller.ts`
parses one config and one input manifest, claims roots, stages copies, sources
`env.sh` once to get the product environment `E`, proves `E` is a fixed point of
re-sourcing, then sets `process.env = E` and runs a typed stage table. Command
stages are children of a process-group runner with `E` plus a declared
stage-local overlay. In-process steps (captures, restaging, sealing) import the
product's own helpers from the same tree, so captures and builds read one
environment by construction. Rehearsal is the same run over a private copy of a
retained artifact root, with a suffix of the stage table.

**B. Recipe strings plus helper CLI.** A TypeScript port of the Python template:
each stage is a bash string prefixed with `source ./env.sh`, and a separate
publication CLI is called per step with its context passed through environment
variables and a prepared-inputs file. This is closest to what passed unit 6.

A is smaller: no context serialization, no helper dispatch, no per-stage
re-sourcing whose sameness rests on idempotence, no separate control checkout
(the controller is product source now, so "load validators from the product, not
the control" disappears). B keeps three failure points the assessment named
(unsourced capture, per-stage env drift, duplicated metadata). Rejected outright:
porting the control branch as-is (template surgery, cohort JSON, authority).

## Caller usage

```sh
source env.sh            # only to find bun; the run rebuilds its own environment
bun scripts/c1-controller.ts check    /private/c1.config.json
bun scripts/c1-controller.ts rehearse /private/c1.config.json --from /retained/artifact [--stage NAME]
bun scripts/c1-controller.ts run      /private/c1.config.json --execute <config sha256>
```

- `check` authenticates config, manifest and every input read-only, prints the
  config digest and every unverified draft entry, and exits nonzero on any draft.
  It then stages only the private toolchain copies into the configured private
  root, establishes `E`, runs the environment gates and the native entry, and
  removes the private root. No report, artifact or product write.
- `run` requires `--execute` equal to the SHA-256 of the config file bytes (the
  file must be canonical JSON, so the digest is stable). That flag is the
  explicit intent; there is no authority document, unit number or exhausted-unit
  list.
- `rehearse` never seals a delivery and is never qualifying (below).

## Core types (sketch)

```ts
// scripts/c1/inputs.ts
interface FileIdentity { readonly path: string; readonly bytes: number; readonly sha256: string }
interface TreeIdentity extends FileIdentity { readonly files: number }
type Provenance =
  | { readonly status: "verified"; readonly receipts: readonly FileIdentity[] }
  | { readonly status: "draft"; readonly missing: string };   // never launch-ready

interface InputManifest {
  readonly schema: "bun-wasm.c1-inputs/1";
  readonly source: { readonly head: string; readonly tree: string };
  readonly runtime: { readonly version: string; readonly sourceCommit: string; readonly archive: FileIdentity; readonly provenance: Provenance };
  readonly relay: { readonly version: string; readonly archive: FileIdentity; readonly provenance: Provenance };
  readonly programs: { readonly tag: string; readonly schema: string; readonly hostInterface: number;
    readonly manifest: FileIdentity; readonly checksums: FileIdentity; readonly archives: readonly FileIdentity[] };
  readonly fd3: { readonly artifact: FileIdentity; readonly receipt: FileIdentity; readonly provenance: Provenance };
  readonly native: { readonly jsc: NativeRoot; readonly sdk: NativeRoot; readonly sysroot: NativeRoot;
    readonly shell: NativeRoot & { readonly bashWeb: string } };
  readonly donors: Readonly<Record<DonorName, TreeIdentity>>;   // bun, boringssl, 3x node_modules, cargo, rustup, tools, bunCache
  readonly tools: Readonly<Record<ToolName, FileIdentity>>;
}
interface NativeRoot { readonly root: string; readonly files: readonly FileIdentity[]; readonly provenance: Provenance }

interface C1Config {
  readonly schema: "bun-wasm.c1-config/1";
  readonly sourceRoot: string;
  readonly manifest: FileIdentity;            // binds the one input manifest
  readonly roots: { readonly report: string; readonly artifact: string; readonly private: string;
    readonly browserTmp: string; readonly qualification: string };
  readonly jobs: number;
}
function loadRun(configPath: string): { config: C1Config; manifest: InputManifest; digest: string };
function authenticate(run): Authenticated;    // all hashes, native reuse validators, no writes

// scripts/c1/environment.ts
interface ProductEnvironment { readonly env: Readonly<Record<string, string>>; readonly tools: Readonly<Record<ToolName, string>> }
function establishEnvironment(a: Authenticated): Promise<ProductEnvironment>;  // allowlisted base, source once, fixed-point proof, tool and receipt gates

// scripts/c1/run.ts
interface Stage {
  readonly name: string;                      // log name in the report
  readonly sourceBound: boolean;              // consumes bytes built from the selected source
  readonly needs: readonly string[];          // artifact-relative inputs from earlier stages
  readonly command?: (c: Context) => { argv: readonly string[]; overlay?: Readonly<Record<string, string>> };
  readonly step?: (c: Context) => Promise<void>;
}
const STAGES: readonly Stage[];
function claim(roots): Claimed;               // exclusive mkdir, report first, 0700
function runStages(c: Context, stages: readonly Stage[], signal: AbortSignal): Promise<void>;

// scripts/c1/publication.ts: capture, restage, stageGuest, matrix, stageDelivery, verifyDelivery, seal
```

`DonorName` and the required path lists come from the product where it already
says them: the BoringSSL and Bun paths from `guest-source-manifest.ts` groups,
the runtime and program pins from `waffle-release-inputs.json`, the Bash pin
from `web/package.json`, the WebKit and Bun commits from `jsc/common.sh` and
`sync-bun.sh`. The manifest supplies only what the product cannot know: local
paths, donor tree identities, tool binaries, the relay and fd3 identities, and
native roots with their original receipts. A value both sides state must agree.

## Run flow

1. Parse and authenticate (no writes). Any `draft` provenance refuses `run`.
2. Claim: `mkdir` report (0700, non-recursive, fails if present), then artifact,
   private and browser roots. Fresh-root rules from preflight carry over: absolute,
   absent, parent present, disjoint from each other, from the product and from
   every input. Teardown is installed before the first write.
3. Stage donors: reflink copies, explicit tool selection, internal absolute links
   rebased, no hard links, staged tree identity rechecked. CMake and Ninja stay
   at the sysroot receipt's canonical paths.
4. Establish `E`: base environment is an allowlist (HOME, USER, LANG, a PATH of
   pinned tool directories plus `/usr/bin:/bin`) plus the prepared values; no
   ambient Rust flags, launcher overrides or tokens can enter. `bash -c 'source
   ./env.sh; env -0'` gives `E`. Re-sourcing under `E` (env.sh twice, then
   jsc/common.sh) must give identical values and identical resolved tools; only
   PATH may grow. Gates: every pinned tool resolves to its bytes, Rust and Waffle
   tools to the private copies, SDK tools to the native SDK, CMake and Ninja to
   the receipt paths, target Rust flags link the native sysroot, the sysroot
   receipt equals `wasiSysrootInputs` under `E`, the JSC stamp equals
   `jsc_inputs_hash` under `E`. Recorded once as `environment.json`.
5. Stages, in order: native entry, capture before, default Browser, source-cache
   Browser, tools, split producer, JSC embedding (overlay
   `BUN_WASM_LAUNCHER=<engine root>/launcher/bun-wasm`), default and source-cache
   Web guests, the Next five-owner callback driver (handoff, below), matrix inputs,
   publication matrix (overlay `TMPDIR=TMP=TEMP=<browserTmp>`), split verify,
   native after, capture after, native preseal, capture preseal, stage, source
   archive, complete-publication verify, seal.
6. Seal: write `DELIVERY.json` once, inventory excludes itself, files 0444,
   directories 0555, `RESULT.json` binds the manifest digest. Status is
   `producer-complete; awaiting-independent-parent-byte-intake`;
   `parentByteIntake`, host qualification, acceptance and deployment stay null.
7. Teardown on every outcome: stop the current stage's group (TERM, 30 s, KILL),
   wait until no member of the group remains, then remove staged product paths,
   private and browser roots. Report and artifact are kept. One `cleanup.json`.

Report contents: `inputs.json` (the authenticated manifest copy with recomputed
identities), `environment.json`, `stages.json` plus one log per stage,
`RESULT.json` (status, delivery digest, failure if any) and `cleanup.json`.
The seven overlapping custody and start/exit summaries go away. The delivery's
before/after/preseal captures stay, because they are the drift gate.

## Rehearsal

`rehearse --from R` claims fresh report, private and browser roots, reflinks `R`
into the private root and runs the stage suffix from `--stage` (default: first
stage whose `needs` are present) against that copy, in the same `E`. The
original `R` is hashed before and after and must not change.

The selected source and tuple are enforced. When `R`'s recorded source or tuple
differs, each `sourceBound` stage is reported `blocked` with the list of
current-source artifacts that do not exist; only generic stages run (repeated
restaging over 0444 originals, seal on the copy, drain and cleanup). Output is
`REHEARSAL.json` with `qualifying: false` always, the provenance of `R` (path,
recorded source and tuple, tree identity) and per-stage `ran | blocked | failed`.
It never writes `DELIVERY.json` status or `RESULT.json`. Unit 6 bytes can
therefore exercise copying, restaging, sealing and cleanup, and nothing else.

For relocated copies to verify, the split producer manifest records the
launcher, its receipt and the web root relative to the engine root (one small
`engine-producer.ts` change). External roots such as the native prebuild stay
absolute.

## Next handoff

The callback matrix is Next's driver in the merged source. The controller runs it
as one stage: argv from the source tree, read-only exact artifact paths, their
original receipts and recomputed identities as a JSON input, and
`roots.qualification` as its only writable output. The controller does not
rebuild anything for it and does not duplicate consumer qualification.

## Invariants kept

| Invariant | Where |
| --- | --- |
| Exclusive fresh roots | `claim()`: non-recursive mkdir, report first, disjointness checks |
| Source and tuple equality | product pins vs manifest, `git` head/tree/clean at start, after build, preseal |
| Full hashes, custody, native reuse | ported validators: JSC artifact list, compiler header roots, WebKit patch tree, sysroot receipt, shell receipt and pin, Bun patch series, Cargo path deps |
| Physical short browser scratch | browserTmp is a claimed root: derived TMPDIR at most 48 bytes, physical parent, observed while live, empty after |
| Atomic writable staging | `restage()`: temp copy, 0644, rename; originals keep bytes, mode, inode |
| Complete publication registry | `requireCompletePublicationFiles` from the same tree |
| Drain before deleting dependencies | process-group runner, teardown waits for empty group |
| Delivery vs parent intake | sealed status fields, rehearsal never qualifying |

Validators that read the native JSC backing still create and remove a temporary
Git index and may refresh timestamps of byte-identical loose objects; the
content-custody contract permits this. Nothing else writes to an input.

## Deletion and migration

- Delete `scripts/producer-start.ts`, its test and `checks/quality-producer-start.json`;
  the claim moves into `claim()`. No other caller exists on main.
- Rename the registry's `inputs/runtime107-release.tgz` to
  `inputs/runtime-release.tgz` (question 4).
- Do not merge or graft the control branch; it stays historical with the unit 6
  evidence. No historical report, artifact or receipt changes.
- New modules: `scripts/c1-controller.ts` and `scripts/c1/{inputs,environment,run,publication}.ts`,
  with tests and one `checks/web-c1-*.json` per test file. Target under 1,500
  lines of source.

## Verification

Ordinary host tests on synthetic inputs, each written to fail on the old
behavior first:

- unit 4: a private CMake or Ninja shadowing the receipt tool fails the
  environment gate;
- assessment faults: a core input capture taken outside `E` differs from the
  build's (the old split), and under `E` they match; the embedding stage without
  its overlay resolves the wrong launcher; the source-cache stage loses the
  sysroot link flags without `E`;
- source or tuple mismatch (head, tree, dirty tree, runtime, relay, programs,
  Bash pin, fd3) fails before claim;
- repeated restaging over 0444 originals;
- TMPDIR: 12-byte root passes, 13-byte root and symlinked parent fail before
  claim, a runner reporting a longer or foreign scratch is stopped;
- cancellation with a TERM-ignoring grandchild drains the group before any
  dependency removal;
- claim: existing report, overlapping roots and a wrong `--execute` digest leave
  nothing created;
- rehearsal: mismatched retained source blocks every source-bound stage, records
  provenance, never marks qualifying, and leaves the retained root unchanged;
- draft provenance refuses `run` and is listed by `check`.

Then `bun run quality`, `tsc` for scripts, knip, duplicates and check discovery.
The only real-input command is `check` against the parent's read-only backing,
and only once Next's inputs are verified and the parent grants it. No guest,
native or launcher build.

## Questions for Next

1. Final source: which merged commit carries the five-owner driver and its check
   manifest, and the driver's exact argv, input JSON shape and output contract
   under `roots.qualification`?
2. Native JSC: since `jsc/common.sh` changed, does Next expect a new native JSC
   prebuild (its own grant), or a proof that the stamp is unchanged? Until then
   the JSC root is `draft`.
3. Bash `fc8327a3` guests and receipt: where do they come from, and who owns them?
4. Does independent intake of the sealed runtime 109 delivery read main's
   registry (the `runtime107-release.tgz` name) or the producer manifest's
   absolute launcher and web root paths? If so, rename and relativize only after
   that intake completes.
5. Runtime 0.0.110 local archive path and its authentication record; relay
   0.0.109 archive source.
6. Cargo offline cache: will the donor be refreshed for the new Cargo.lock
   crates, and who proves it before a run?
7. Delivery layout: keep the nine per-phase custody files, or accept one
   `custody.json` with three phases?
