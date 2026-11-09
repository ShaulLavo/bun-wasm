# Bun process observation through native return

Status: Approved. Runtime and relay 0.0.114 plus programs 0.0.16 are pinned and locally checked at interface 2. Reviewed, merged Bash source and green normal CI remain required before landing.

## Contract

The root runner captures the canonical Waffle process observation before acquiring a Worker. Logical result selection and collection do not end that observation. Successful native termination return changes it to `terminated`. A void return publishes synchronously. A fulfilled promise publishes at fulfillment. A thrown or rejected native stop preserves the original failure and does not publish termination.

`run.done` stays responsive after the filesystem fence. It does not await a held native stop. The runtime retains the separate asynchronous acquisition and stop obligation. A late Worker is terminated exactly once and receives no guest start. Filesystem, terminal, notification and memory-group cleanup remain separate obligations. There is no launch quota or claim that native return proves every reader physically closed.

## Verified baseline

Fresh origin/main e69f2afb3286abd832773fbc6d64f2f8e7b6cbe5 was verified before production edits with the parent-provided development runtime. All child launcher controls passed unchanged. The original direct root stop hook read a collected producer and rejected cleanup. Real CPU Workers then reproduced selected observations after held, void and fulfilled native returns.

## Implementation

- Keep a captured observer beside the canonical producer used only for result arbitration.
- Publish native return independently of resource retirement.
- Publish the acquisition promise before entering borrowed runtime callbacks. Join that promise during stop, including reentrant disposal, instead of dropping a later Worker.
- Preserve the broker's root lease release during page disposal and its captured memory-group cleanup.
- After held terminal or nested imports, skip Bun executor construction for a selected or terminated process. Generic bootstrap owns reporting and cleanup.
- Keep browser child launchers unchanged because Waffle already owns their accepted preparation and native stop.
- Bind the Node adapter root to its original directory observation. Capture each native Worker termination once, keep pending stops owned across exit events, preserve failure identities, and propagate failed disposal instead of swallowing it.
- Validate posted test ownership against the original directory, slot, and lifetime rather than constructing a replacement process.

The feature-owned `checks/web-runner-process-observation.json` runs the real CPU controls through Web's existing blocking discovery. Existing root, signal, filesystem and launcher suites keep their scopes and deadlines. The original stop probe records each root retirement once because Waffle's stop and disposal paths may acknowledge the same idempotent retirement. The descendant fixture holds native return while its already-posted spawn remains queued. The metadata-only disposal fixture releases its root lease before disposing the owner. All original assertions and deadlines remain.

## Landing dependency

Root, Web, and sandbox now select published runtime 0.0.114. Root and Web select its paired relay. Root metadata and native release inputs use host interface 2 and source 341bf1452d98e280a5c718af2775a839ff4042fa. Frozen installs pass without preparing or rebuilding those packages. Programs 0.0.16 is now public and selected through the updater. The coordinator owns normal CI and merge after the reviewed, merged interface-2 Bash source completes consumer adoption. No development archive URL or package version bump belongs in this PR.


## Local gate results

The real CPU observation manifest passes 24 controls. Focused root-stop and Shell ownership checks pass 93 tests together. Package checks pass 335 tests, and check discovery passes 118 tests. Package, script, Web and sandbox types, lint, unused-source checks and duplicate checks pass.

The complete Web unit suite passes 1,806 tests and skips one. Its only failure is the unchanged base-family host-interface check, because main's base package still declares interface 1 and this development runtime declares interface 2. Quality probes pass 2,615 tests and skip one. Their only failure checks the supported installed release version, which is still 0.0.113 in the retained release inputs rather than development 0.0.114. These two gates must be rerun with the parent's supported replacements. They are not waived or relabeled green.

## Independent review correction

The reviewer reproduced disposal reentering through `runtime.processes()` before acquisition was stored. The run completed, but native termination never ran. The runner now schedules acquisition after storing its promise. The CI-discovered reentrant control arms a real CPU observer before acquisition, holds its return, and checks exactly one native stop, no guest start, and a late `terminated` result. It failed before the fix with a zero stop count and passes afterward. Types, lint, discovery, and the 93 focused tests pass.

## Published runtime qualification

Runtime and relay 0.0.114 are published, source 341bf1452d98e280a5c718af2775a839ff4042fa. The complete program tuple is still pending. Runtime-only qualification found that the published SDK acknowledges its controller through an internal recursive `rootStopped` call. The grant-lifetime test now observes Bun's own acknowledgment boundary, without counting SDK recursion as another consumer stop. All existing assertions remain: one native termination, one consumer acknowledgment, a live grant before return, and no grant after return. No production change is needed for that distinction.

After reconciling main at 95cc826e1, the normal JavaScript quality command passes on the committed public runtime selection. The focused observation, ownership, and host-interface suites pass 210 tests. Package checks pass 335 tests. Interface tests derive their matching and nonmatching metadata from the selection, preserving exact rejection coverage without treating interface 1 as current. Historical self-contained interface-1 fixtures remain unchanged. Complete Web acceptance remains blocked by the old program family and Bash source until their replacements arrive.

## Complete migration ownership

PR 562 owns the entire Waffle 0.0.114 migration. The release record now includes the paired relay URL, version, source, hash, byte count, and exact host interface. Producer selection checks the Web pin against that record, and release admission verifies relay bytes rather than only its version and filename. The updater compares all native source inputs with the released archive and rejects runtime, relay, or program interface drift before any record write. Negative controls failed before these fixes and pass afterward. Existing historical program provenance remains unchanged until the published 0.0.16 handoff replaces it.

The normal selector reports `rust=true`, `jsc=true`, `shared=true`, and `shared_native=true` for this migration. The existing Shared PIC job produces and consumes both QuickJS and JSC group profiles, including their real Chromium checks. Their passing hosted results remain required, not replaced by the source-only selector proof. Engines will rebase on this integration after merge; no launcher discriminator hunk or caller-controlled environment flag is added here.

## Public program tuple adopted

The updater successfully regenerated the real released closure using manifest c502306e1c5e2931ae14b2a7f0a9975a05cb5345032f7ae4540e7a53be8357ce and base 52dc39f922c07bc173c520f8442edadf619061a6d9e6c28055459f15eddb44e9. Program source 3050f69d810fe7c851e487135517698b5dfd93e5 remains original; clean rebind and acceptance tool 3bf98e950ea0e53bc9a2a35d503b08d5a1117e00 is recorded separately. Runtime and relay stay on source 341bf1452d98e280a5c718af2775a839ff4042fa. All generated fields match the release owner's public tuple.

Normal and frozen installs pass in all three consumer scopes. The focused group passes 242 tests, including the actual CPU observation controls. Types and lint pass. Full Web now has 1,814 passes, one skip, and only the retained Bash interface-1 failure. The base-family mismatch is gone. No Bash candidate is adopted before its review and merge, and the complete Web gate remains blocking.
