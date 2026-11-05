# One C1 controller

Status: Approved no-build preparation. Parent incorporated the seven bounded
corrections from the independent Sol review of b6398db3. Design A remains the
chosen shape. The original CHANGES REQUESTED verdict remains historical evidence;
this reconciliation does not claim code, production or consumer acceptance.

Base: main 61a86be3741b22576b149d271e6ea87618c20e9c, tree
180a04fd181f22f703e6a3e9e54870eef844279d, including PR 470. Final source is NOT
frozen. It must be the actual merged controller, fixture/driver and required TLS
adapter source, never this base, a dirty overlay or a synthetic merge label.
Unit 6 is consumed. There is no new production execution grant.

## Contract and scope

One runtime 110 production serves three independently owned consumers: five-owner
qualification, Bun TLS and remaining relay needs not covered by unit 6. Count the
shared build once. Next owns the aggregate consumer requirements and five-owner
fixtures/drivers/checks; TLS owns its contract and driver adapter; relay owns its
remaining consumer requirements. Engines owns controller/config/input-manifest
source and a read-only produced-byte handoff, not another consumer build pipeline.

Canonical aggregate requirements are under
/work/reports/wave-20261105/bun/runtime110-qualification-contract/CONSUMER-CONTRACT.json:
16,006 bytes, SHA-256
8f7fdd337114f2cd7188601845a416cd57b7a54aa6889f1b016aa2dda7409730.
TLS-CONSUMER-CONTRACT.json is 22,783 bytes, SHA-256
cb87f25fb6e7b379936135102e844293004946053f96a42d4072df7e1d9f3c4a.
Next's prepared five-owner DRIVER-CONTRACT.json is 8,469 bytes, SHA-256
32e9aa03a4f3f6b416e73bc05ba35b886a8c2e8e65c4fd23eecb84511c53e92c
at /work/reports/wave-20261105/bun/pr470-real-guest-preparation/.
These are consumer requirements, not additional producer configs, input manifests,
intake receipts or execution authority. Relay's exact requirements are pending.
Driver contracts remain subject to their owners' source review and merge.

## Grounding and alternatives

Current main has the split producer, complete-publication registry and
producer-start.ts claim guard, but no C1 controller. Successful historical control
5aef1f42 is a code/lesson donor only: roughly 2,400 lines, a rewritten Python
template, a pinned cohort inventory and per-unit authority documents. Do not graft
its source cohort, old validators or historical pins into current main.

Unit 6 used ffbccf9a and runtime 109. Current main changed runtime/Bash pins,
BoringSSL source closure, jsc/common.sh and Cargo.lock. Unit 6 guests, sides,
launcher and native profiles are not automatically current-source candidates.
Its independent byte admission is not TLS acceptance: the old builtins.js maps
node:tls to unsupportedModule.

A, chosen: one TypeScript process owns one typed operation. It loads one config
and one input manifest, admits actual inputs/environment, executes shared stage
definitions, validates/seals output and owns descendant cleanup. Product helpers
come from the selected source. Rehearsal shares definitions, not copied recipes.

B, rejected: port Python recipes to TypeScript strings and dispatch a separate
publication CLI, sourcing env.sh in each child. That keeps duplicated context,
environment drift and serialized metadata. No historical template surgery,
separate control cohort or per-unit paperwork remains in A.

## Caller usage

~~~sh
bun scripts/c1-controller.ts check CONFIG
bun scripts/c1-controller.ts rehearse CONFIG --from RETAINED [--stage NAME]
bun scripts/c1-controller.ts run CONFIG --execute CONFIG_SHA256
bun scripts/c1-controller.ts qualify CONFIG --intake RECEIPT --intake-sha256 SHA256
~~~

The config digest binds exact raw bytes, not a reserialized copy. The run flag is
explicit execution intent; the approved combined execution decision still comes
from managing. There is no unit number, exhausted-unit list or authority document.
Check refuses production inputs that remain draft. Rehearsal can test generic
mechanics while source-specific inputs remain draft, but is never qualifying.
Qualify is a separate post-intake operation, never a preseal producer stage.

## Domain shape

~~~ts
interface FileIdentity { readonly path: string; readonly bytes: number; readonly sha256: string }
interface TreeIdentity extends FileIdentity { readonly files: number }
type Provenance =
  | { readonly status: "verified"; readonly receipts: readonly FileIdentity[] }
  | { readonly status: "draft"; readonly missing: string };
interface InputManifest {
  readonly schema: "bun-wasm.c1-inputs/1";
  readonly source: SourceIdentity;
  readonly runtime: RuntimeInput;
  readonly relay: RelayInput;
  readonly programs: ProgramInputs;
  readonly fd3: Fd3Inputs;
  readonly native: NativeInputs;
  readonly donors: Readonly<Record<DonorName, TreeIdentity>>;
  readonly tools: Readonly<Record<ToolName, FileIdentity>>;
  readonly consumerDependencies: ConsumerDependencies;
}
interface C1Config {
  readonly schema: "bun-wasm.c1-config/1";
  readonly sourceRoot: string;
  readonly manifest: FileIdentity;
  readonly roots: OwnedRootSelection;
  readonly jobs: number;
}
type Action =
  | { readonly kind: "command"; readonly command: (c: Context) => Command }
  | { readonly kind: "step"; readonly step: (c: Context, signal: AbortSignal, owner: OwnedProcesses) => Promise<void> };
type Eligibility = "production-only" | "validated-retained" | "generic-rehearsal";
interface Stage {
  readonly name: string;
  readonly eligibility: Eligibility;
  readonly needs: readonly ArtifactRequirement[];
  readonly action: Action;
}
function admit(run: ParsedRun, scope: AdmissionScope): Promise<Authenticated>;
function establishEnvironment(inputs: PreparedInputs): Promise<ProductEnvironment>;
function claim(roots: RootSelection): Claimed;
function runStages(context: Context, stages: readonly Stage[], signal: AbortSignal): Promise<void>;
~~~

Names are sketches, not a second handwritten protocol. Derive concrete receipt
and artifact types from maintained helpers. Parse exact JSON variants at the
boundary; reject unknown/missing tool and donor names. Caller-supplied verified
labels and empty receipt lists do not authenticate anything. Authentication checks
actual bytes, original receipt semantics and source/interface/provenance, then
constructs the internal authenticated value without casts.

The manifest supplies external facts: local paths, full donor identities, tool
binaries, original native/relay/fd3 receipts and complete consumer dependency
closure. Derive product-pinned runtime/program/Bash/source requirements from the
selected source; if both sides state a value they must agree. Original program
source/tool provenance is never rewritten as runtime 110 provenance.

## Admission and environment before a durable claim

Bind the running controller repository to sourceRoot and manifest head/tree before
executing product helpers. Keep structural parsing, byte authentication and full
sourced native admission distinct; none can silently stand in for the others.

Install teardown before any write. Use invocation-owned private admission scratch
for actual tool/dependency copies and the same logical paths the run will use.
Include installed Waffle and authenticated archives resolved by native helpers,
not toolchain copies alone. A private view/namespace may expose prospective logical
paths without writing original product/native roots or claiming the final report.
Reuse the authenticated staged copies for run rather than assemble a second
independent environment. Validate that the final staged view matches its witness.

The same admission routine serves check and run. All required sourced native and
sysroot compatibility facts must be established before durable report claim.
Reject missing Waffle inputs, stale JSC stamps and missing native objects without
adding original files, changing the persistent index, downloading or rebuilding.
Native patch verification uses a private Git index and object directory, with
original objects available read-only as alternates. Do not call a builder CLI with
a hidden downloader fallback and describe it as read-only validation. In
particular, write-tree --missing-ok is not pure. Check original metadata and bytes
before/after admission and remove the private scope on every outcome.

E is established from an allowlisted base and selected-source env.sh, not ambient
Rust flags, launcher overrides, tokens or copied historical flags. Compare
semantic environment values and resolved executable bytes after repeated sourcing.
Normalize only declared shell bookkeeping such as _, SHLVL and PWD and duplicate
PATH prefixes; do not ignore compiler flags or arbitrary variables.

Record E once. Maintained Browser, tools, source-cache and JSC helpers apply
explicit profile transformations: target directories, guest tool selection,
engineEnvironment and PATH_NO_BINARYEN. Captures and commands use the same variant
of E. Publish E before environment-sensitive initialization or pass it explicitly.
Never import the argv-parsing engine-producer CLI as a library.

Canonical CMake/Ninja paths must match the original sysroot receipt; private
shadow copies fail. Bind all Rust, SDK, Waffle, Bun/Node and native paths/versions/
bytes and complete offline lockfile/build-std inputs. Use private copies, no
writable hard links to a seed and no mutation of held donor caches.

## Root ownership

All writable roots and staged product destinations undergo canonical physical
parent, freshness, symlink/alias and containment checks against source, config,
manifest, receipts, donor/native roots and any external rehearsal root R. Inputs
may not contain outputs or be reachable through an output alias. Browser scratch
also reserves space for the exact expanded runner suffix, at most 48 UTF-8 bytes.

| Operation | Acquired roots | Retained output |
| --- | --- | --- |
| check | invocation-owned admission scratch only | bounded caller-requested check evidence; no configured root claim |
| run | report, artifact, private, browser | report and sealed/failed artifact |
| rehearse | report, private, browser; retained copy under private | report and explicitly rehearsal-only evidence, no producer artifact claim |
| qualify | fresh qualification output plus private/browser scratch | separate consumer results and cleanup; producer report/delivery read-only |

After full admission, run exclusively creates its report first, mode 0700, then
its other final roots. A Claimed value owns only roots this invocation actually
created. On a later claim failure, keep its report, clean only acquired scratch
and never remove or modify the pre-existing conflicting root. Existing-root
refusal performs neither preparation nor cleanup on the existing report.
Register staged product output ownership before the stage that creates it.

Qualification exclusively claims its fresh output once and writes distinct
five-owner/TLS/relay results beneath it. It cannot overwrite a prior qualification,
producer root, source or input. No consumer starts with an unowned writable path.

## Production and cleanup

The production sequence retains: full native admission, capture before, default
Browser, distinct source-cache Browser, tools, one split core/QuickJS/JSC producer,
full selected-launcher JSC embedding, default/source-cache Web consumers, complete
Chromium/Firefox/WebKit publication, split verification, native/source/vendor/input
after/preseal checks, publication/source archive/complete registry and single-write
sealing. No new consumer is inserted before sealing or independent byte intake.

The embedding launcher binding is stage-local, never a global supplied-launcher
shortcut. Browser scratch is physical, observed while live, within the 48-byte
limit and empty after shutdown. Apply this rule to every Chromium stage, including
hook smoke and later lane-owned consumer drivers, not only the final matrix.

Keep existing source/vendor/native before/after/preseal captures until all current
validators migrate together. One external input manifest does not mean deleting
the three-phase drift gate. Reduce overlapping report/start/exit summaries to one
authenticated input record, environment record, stage log/index, result and cleanup.
Seal DELIVERY exactly once after full validation, with a closed payload set and
an external manifest digest. Modes come from the maintained registry, never from
input mode bits or file names: executable members (`executableMemberPaths()`,
today only the native launcher) are 0555, every other file 0444, directories
0555. The manifest records each member's mode; verification, intake and handoff
checks refuse any other mode. Consumers never chmod sealed files: a new launcher
runs from its sealed path once admitted. Producer status means awaiting
independent parent byte intake, never consumer acceptance.

Share or extract the maintained ownership in run-with-timeout.mts: subreaping,
descendant identity and birth time, detached/setsid children and in-process-step
subprocesses. Every step receives cancellation and uses this owner. Escalate and
verify the whole owned set after ordinary exit as well as abort. Cover a parent
that exits first and a matrix child that ignores TERM. PID reuse must not target
an unrelated process. If drain is unproved, retain dependencies and report unsafe
cleanup rather than delete them or wait forever.

## Retained-artifact rehearsal

Rehearsal runs no build/producer action. It validates the requested stages against
ArtifactRequirement identities and authenticated source/tuple/profile/receipts,
not file presence or a first-available-file suffix heuristic. Blocked prerequisites
propagate. A matching source with a stale receipt remains blocked; an explicit
inadmissible stage refuses. Hash the protected retained original before and after;
all writes belong to its private copy and owned scratch.

A mismatched old source can exercise generic copy/restage/seal mechanics and cleanup
while production inputs remain draft. It cannot run unproved current-source
consumers. Qualifying is always false. Existing copied ADMISSION/DELIVERY/status
files are historical input, never new evidence. Do not run a verifier that promotes
ADMISSION or emit fresh production RESULT/DELIVERY from rehearsal. A rehearsal-only
inventory/seal tests the same mechanics without claiming producer status.

The complete unit 6 delivery is runtime 109 evidence only. It is held immutable.
Failed unit 5 binaries have a specific cleanup release and are not new test inputs.

## Strict delivery, intake and three-consumer interface

Emit a single read-only handoff for the sealed producer output. Before any consumer,
qualify requires independent parent intake of that exact delivery root, manifest
and custody digest, source and tuple. Missing/wrong intake or old unit 6 admission
for a new closure refuses all consumers. A matching intake reaches each required
lane-owned driver once, without any build action.

Publish actual exported delivery/intake/dependency types and an executable fixture
early in implementation, then reconcile directly with Next and TLS before freezing
source. The interface binds original absolute paths and actual membership/bytes/
hashes for guest/core/side/launcher/host/source/config/input/environment/native
receipts, complete host dependencies/frozen locks and consumer dependencies. A
current arbitrary install cannot be blessed merely by hashing it after the fact.
New deliveries seal the launcher 0555, so the handoff names its sealed path and
no copy. Unit 6's admitted launcher stays 0444 and is never modified, repaired or
resealed; its PermissionError is not a guest result. Inspecting such old sealed
artifacts needs a private byte-identical executable view under its own authority;
that is historical inspection, not a production format fallback.

Next's prepared driver at 55af5a4e is subject to its independent source review.
It explicitly selects qjs/jsc guest+launcher+shell/env or Chromium web root, fresh
output and --qualify HEAD TREE. Bind every actually loaded Browser .wasm/.js byte
to the admitted registry before accepting a result. Its result schema is
bun-wasm.io-resource-context.result.v1 with 22 requested rows and ten explicitly
unqualified fault/GC/descriptor limits; host-only controls are not engine passes.

TLS PRs 456/461/462 already landed; do not repush old aabe67d4 source. TLS owns
runtime 110 adapter preparation e33458e8 and its remaining strict synthetic fixture
migration. It is approved for preparation only, not real intake support. Reconcile
its existing runtime 109/historical parent/source-release fields to ONE selected
new strict delivery/intake/dependency contract. Do not manufacture old fields,
reuse a unit 6 receipt, pass a config hash as an old source-release authority hash
or add an old/new fallback. Engines changes controller/closure fields; TLS changes
its owned driver. No duplicate TLS implementation or source push.

TLS requires current registered Rust/client/roots/crypto source, actual libssl+
libcrypto Cargo binding through maintained crypto production, exact runtime 110 /
relay 109 / interface 1, original receipts/custody, complete frozen unmodified
pg 8.16.3/transitive inputs and host dependencies. No extra TLS feature/native
profile is guessed. Auxiliary page/worker bundle placement and identity are a
pre-freeze interface item; consumers never rebuild guests. Database/browser/
credential/provisioning execution is not authorized now. TLS marginal estimate is
1.75-3.5 focused and 2.5-5 elapsed hours beyond shared production/five-owner work.
The old 4-7 focused / 5-9 elapsed estimate is BASE five-owner+warm-production only.
The expanded total waits for relay marginal cost and all controller/driver gates.

## Caller migration and blocking tests

Relative launcher/receipt/web paths require writer, engine-producer verifier,
measure-runtime-js reader and their fixtures to migrate together. Reject absolute
injected paths and traversal before resolving under the selected engine root.
Preserve original receipt bytes. No old/new fallback. Historical consumers use
explicitly selected pinned historical validators, not rewritten old evidence.

Rename the historical runtime107-release.tgz registry entry to the actual selected
runtime archive path only with all current readers and TLS adapter migrated. Do
not satisfy the new closure using an unused old archive or relabelled bytes.

Remove standalone producer-start.ts only while migrating its refusal/exclusive
claim tests to QUALITY-owned discovery, preserving that blocking owner. Test old
files/directories/all symlink and dangling-link forms, unchanged metadata,
simultaneous contenders, absent parent/invalid args, and retained claims after
failure/signal/failed execution. Losing/existing-root starts change no old report
and perform no preparation or cleanup on it. Only the obsolete execve same-PID
assertion goes. Web-owned tests cover other behavior without duplicate guard runs.

New code is TypeScript and maximum nesting is three blocks. The 1,500-line guide
is not permission to compress validators or weaken failure details. Use a small
module map owning inputs, environment, process lifecycle and publication facts,
not pass-through or temporal wrappers. Migrate callers and delete superseded
active APIs in this wave; retained historical controls/evidence remain untouched.

## Implementation verification and remaining draft data

Required controls include prior CMake/Ninja shadowing, capture/build flag mismatch,
wrong embedding launcher, lost source-cache flags, source/tuple/dirty/provenance
mismatch, repeated 0444 staging, observed physical scratch, admission with missing
Git objects/Waffle inputs or a wrong stamp, every root alias/overlap/partial claim,
discriminated action validation, stale/blocked rehearsal prerequisites, all detached
cleanup/cancellation paths, current reader migration and intake-gated consumers.
Use real maintained code on private inputs, no declaration/launcher/receipt stubs.
Run existing discovery owners, quality/types/lint/knip/duplicates and relevant
host tests. No real-input check until its current inputs are authenticated and the
parent grants that no-build check. No native/guest/launcher/fd3 build is granted.

Concrete runtime archive: /work/cache/bun-wasm/qualification-inputs/waffle-0.0.110.tgz,
2,360,942 bytes, SHA-256
8887911306a2a500f7f9e103485132dcfd46ff2590576b3cce86f2201d75fb30.
Relay 109/programs 15 original paths, hashes and program source/tool provenance
are in the aggregate contract. fd3 reuse needs actual current source/interface/
provenance/hash validation of its unchanged original 484-byte artifact and
3,157-byte receipt. SDK/sysroot and JSC are candidates only: current jsc/common.sh
inputs changed, so no restamp or relocated configured CMake tree is admitted.
Current Bash must bind fc8327a39fd367193ff8db8c894788ab29544c12; old 32b9103c is not
admitted. Keep held donor inputs unchanged; Engines owns any separately prepared
private current-lockfile/build-std cache closure proof.

Still draft: actual merged final source; exact reviewed driver and new strict
intake/dependency interfaces; current JSC/Bash admission or separately approved
preparation; complete current offline Cargo and host/pg dependencies; host readiness
and aggregate costs. Implement the controller/interface without pretending those
facts exist. Source landing, shared build and consumer execution are separate
checkpoints. Final combined execution-ready plan goes to managing once these are
resolved; no per-unit documents or another design competition.

## Implementation map

- `scripts/c1-controller.ts`: the CLI above.
- `scripts/c1/contract.ts`: config, input manifest, delivery, intake and handoff
  types and strict parsers. `contract-fixture.ts` writes an executable sample.
- `scripts/c1/inputs.ts`: read-only byte and receipt admission. WebKit and Bun
  patch checks use a private index copy and object directory, originals as
  alternates, `GIT_NO_LAZY_FETCH=1`.
- `scripts/c1/admission.ts`: donor staging, E from the allowlisted base, the
  fixed-point check, tool, sysroot, JSC stamp and offline Cargo facts.
- `scripts/c1/roots.ts`: admission and durable root phases, exclusive claim.
- `scripts/process-owner.mts` (shared with `run-with-timeout.mts`) and
  `scripts/c1/process.ts`: subreaped process ownership; unproved drain retains
  dependencies.
- `scripts/c1/publication.ts`, `stages.ts`, `operations.ts`: publication steps,
  the one stage table, check/run/rehearse/qualify.
- `scripts/c1/delivery.ts`: single-write seal with registry modes, sealed
  delivery reader, intake admission, handoff.

After the amended implementation review (F1-F9): every step runs as an owned
child (`scripts/c1/step.ts` over the named exports in `scripts/c1/steps.ts`),
so abort drains captures like commands; `jsc/common.sh`'s WebKit check is
private for every caller, which changes the JSC input stamp (jsc/ sources are
JSC inputs), so any existing native JSC stays draft until a current build or
current-compatible original is admitted; complete native admission (stamp,
archive list, WebKit tree, CMake cache, sysroot verification, header groups)
runs before any durable claim, behind a native-backing metadata witness.
Relay adds no producer gate (`RELAY_DECISION`); its conditional post-intake
consumer belongs to Relay and the controller reports it as not run.

## TLS interface amendment

- Fixture options: `config.fixtures.tls` is a typed `resolved | unresolved`
  `TlsFixtureOptions` (fleet database host, distinct private database and relay
  addresses, unprivileged distinct page and relay ports outside the TLS
  fixture's own 45433/45434). It is bound by the config digest, refuses
  secrets by schema, counts as draft until resolved, and reaches consumers
  only through `handoff.fixtures`. Dependency bytes stay in the input manifest.
- TLS page: the production-only `tls-page-producer.log` stage runs
  `scripts/c1/tls-page.ts`, which bundles `web/tests/tls-relay-page.ts` and the
  maintained workers with `scripts/browser-build.ts` into `tls/page/`, copies
  the pg client to `tls/fixture/`, and writes `tls/page.build.json` binding the
  source, every bundled input and every output. Complete publication runs
  `verifyTlsPage`; the delivery seals it 0444. Qualify serves it read-only from
  `handoff.tlsPageRoot`. The page's relay import must be static: the current
  variable `tls-reviewed-relay` import does not bundle, so production refuses
  until TLS changes its page.
- Loaded evidence: `scripts/c1/loaded.ts` exports `LoadedObservation`,
  `parseLoaded` and `bindLoaded`. Consumers record real GET responses (decoded
  bytes and Content-Encoding) as a top-level `loaded` array; the validator
  derives each row's admitted object from its URL (web root representations,
  TLS page, guest artifact by role, admitted pg seed, pg client, `/seed`
  control) and refuses any unbound, foreign-origin or mismatched row.
- TLS argv proposal for its migrated CLI: `--stage pg-early --browser chromium
  --engine browser --handoff <handoff.json> --handoff-sha256 <sha> --output <dir>`.

## Independent review reconciliation

Original review at b6398db3 remains CHANGES REQUESTED. Parent incorporated R1
post-intake consumers; R2 shared private read-only admission before report claim;
R3 per-operation root ownership; R4 discriminated actions/validated rehearsal
eligibility; R5 identity-aware escaped-descendant ownership; R6 all current reader
migration; R7 quality-owned guard semantics. Design A is unchanged. Opus now
implements this reconciled plan; one independent Sol implementation review follows.
