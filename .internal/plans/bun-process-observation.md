# Bun process observation through native return

Status: Approved. Implementation and focused checks are complete on the development input. Supported Waffle replacement is required before landing.

## Contract

The root runner captures the canonical Waffle process observation before acquiring a Worker. Logical result selection and collection do not end that observation. Successful native termination return changes it to `terminated`. A void return publishes synchronously. A fulfilled promise publishes at fulfillment. A thrown or rejected native stop preserves the original failure and does not publish termination.

`run.done` stays responsive after the filesystem fence. It does not await a held native stop. The runtime retains the separate asynchronous acquisition and stop obligation. A late Worker is terminated exactly once and receives no guest start. Filesystem, terminal, notification and memory-group cleanup remain separate obligations. There is no launch quota or claim that native return proves every reader physically closed.

## Verified baseline

Fresh origin/main e69f2afb3286abd832773fbc6d64f2f8e7b6cbe5 was verified before production edits with the parent-provided development runtime. All child launcher controls passed unchanged. The original direct root stop hook read a collected producer and rejected cleanup. Real CPU Workers then reproduced selected observations after held, void and fulfilled native returns.

## Implementation

- Keep a captured observer beside the canonical producer used only for result arbitration.
- Publish native return independently of resource retirement.
- Join asynchronous Worker acquisition during stop instead of certifying an absent Worker and dropping a later one.
- Preserve the broker's root lease release during page disposal and its captured memory-group cleanup.
- After held terminal or nested imports, skip Bun executor construction for a selected or terminated process. Generic bootstrap owns reporting and cleanup.
- Keep browser child launchers unchanged because Waffle already owns their accepted preparation and native stop.
- Bind the Node adapter root to its original directory observation. Capture each native Worker termination once, keep pending stops owned across exit events, preserve failure identities, and propagate failed disposal instead of swallowing it.
- Validate posted test ownership against the original directory, slot, and lifetime rather than constructing a replacement process.

The feature-owned `checks/web-runner-process-observation.json` runs the real CPU controls through Web's existing blocking discovery. Existing root, signal, filesystem and launcher suites keep their scopes and deadlines. The original stop probe records each root retirement once because Waffle's stop and disposal paths may acknowledge the same idempotent retirement. The descendant fixture holds native return while its already-posted spawn remains queued. The metadata-only disposal fixture releases its root lease before disposing the owner. All original assertions and deadlines remain.

## Landing dependency

No development archive URL or version bump belongs in this PR. The parent owns the supported Waffle release and matching manifest and lockfile replacement. Run normal checks again on that supported replacement and obtain one independent review before landing. This worker does not merge or release.


## Local gate results

The real CPU observation manifest passes 23 controls. Focused root-stop and Shell ownership checks pass 92 tests together. Package checks pass 335 tests, and check discovery passes 118 tests. Package, script, Web and sandbox types, lint, unused-source checks and duplicate checks pass.

The complete Web unit suite passes 1,806 tests and skips one. Its only failure is the unchanged base-family host-interface check, because main's base package still declares interface 1 and this development runtime declares interface 2. Quality probes pass 2,615 tests and skip one. Their only failure checks the supported installed release version, which is still 0.0.113 in the retained release inputs rather than development 0.0.114. These two gates must be rerun with the parent's supported replacements. They are not waived or relabeled green.
