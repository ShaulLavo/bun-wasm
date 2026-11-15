# Browser-native storage CI repair

Status: Approved. Owner: storage CI coordinator. Updated: 2026-11-14.

## Immediate mitigation

Run every existing storage scenario with its existing deadlines and verified site.
Only CI may quarantine the three historical preservation failures below. Match an
explicit scenario checkpoint and the complete diagnostic signature. Persist the
original per-browser failure before accepting a match. A missing report, failed
write, unknown signature, receipt mismatch, cleanup failure, storage assertion,
or later restoration, HMR, or unsupported-symlink failure remains blocking.

- Firefox, first Vite Vue startup after vanilla config restart and Vite React.
  The dev shell exits 254 after fork reports FilesystemTransportError CLOSED,
  errno 29, and failure to deserialize a message. Hono remains ready on 5174
  with counter 1. The Vue preview has no URL and its filesystem reports ready.
- WebKit, first vanilla restart after saving the guest-writing config.
  Readiness reaches its existing deadline, the second dev invocation has no new
  ready message, and the preview reports no server on 5173. Hono remains ready
  on 5174 with counter 1. Vanilla storage is ready with no pending editor text.
- WebKit, first Vite React startup after the vanilla config restart. All 24
  recorded packages install, Vite 8.3.5 becomes ready, then the optimizer starts
  bundling dependencies. A worker reports Out of bounds access and RangeError
  at the exact five host frames, followed by dev exit 1. The existing React
  readiness deadline expires with an empty preview. Hono remains ready on 5174
  with counter 1; both root filesystems are ready with no pending edits. The
  target status is either loading preview or the recorded dev-server-ready
  form. That ready label does not negate the worker error or empty preview.

Chromium preservation, Chromium quota refusal, all unmatched Firefox and WebKit
failures, and every other required check remain blocking. Emit a warning and a
job summary for a quarantined failure. No broad continue-on-error, new retry,
timeout increase, engine change, Waffle pin change, or receipt bypass is allowed.
The quarantine admits a known failed scenario; it does not claim product success.

Both page terminals must match their complete historical transcripts. Normalize
only whitespace, install and ready timings, loopback ports, and worker chunk
hashes and stack coordinates. Any added terminal output, including an error
before the expected failure footer or in the active Hono terminal, stays blocking.
The React entry uses a separate, stricter normalizer. Only elapsed install/ready
times, the optimizer clock, worker thread ID, and terminal loopback ports vary.
Whitespace, dependency versions, error text, and each complete recorded sequence
of five host stack coordinates stay exact. Both terminals must match the same
recorded protocol. No React stack hash or source frame is normalized.

## Evidence

Firefox has one known hosted failure. Jobs 132260477153 and 132268805440 have
identical timestamps and output despite different run-attempt metadata; whether
the latter executed independently is unresolved. Four local controls passed.
The retained protocol belongs to PR 738, run 43530616509.
WebKit failed PR 730, run 43516069702, job 132216974765. The exact-site and
current-main controls passed locally. Both paths select Browser native.

Full reports and original protocols are under
`/work/reports/goals/stack-exhaustion-20261113/quickjs-parser/storage-ci/`
and `/work/reports/goals/stack-exhaustion-20261113/quickjs-core-call/ci/`.
Mitigation checks and cleanup evidence belong under
`/work/reports/goals/storage-ci-20261114/mitigation/`.

React's distinct final protocols are PR 657 run 43545860161 job 132317528894,
PR 738 run 43546088852 job 132317988768, and PR 730 run 43546081559
job 132319996195. PR 738 attempt 2 independently reran at 04:03:14 to
04:07:35 UTC in job 132324771402. Workers 55, 65, 57, and 59 respectively
show the same stack at host 130:17, 15:27, guard 11:9471, pump 11:8296, and 9:90764. PR 730 labels
the target ready in 25.7 seconds; the others show loading preview. The captured
JSON preserves the historical checkpoint, which predated explicit first React
startup tracking. Tests replay these reports at the new source checkpoint only.
New mitigation evidence is retained under
`/work/reports/goals/storage-ci-20261114/react-quarantine/`.

PR 738 head `355ecaff6631714a01841921d0cfe0df0788d057`, run 43566104389,
job 132367629898 records the same failure with final callback frame 9:91027.
Artifact 14102859682 matches its published archive digest; the original site
verifier passes against tested merge `ed2bdf1bef0ea3c2191291e3aac8b422080c794b`.
Actual old and new worker source maps resolve 9:90764 and 9:91027 to the same
MessageChannel callback calling `this.pump()` at EngineHost line 447, column 14.
Both embedded EngineHost sources are byte-identical and the new source matches
the producer commit. The complete new original protocol is an explicit fixture,
not a coordinate normalization. The top throwing frames remain unresolved; this
mapping establishes no connection to the independently proved WASI source bug.
Small receipt, mapping, protocol, and red/green evidence is retained under
`/work/reports/goals/storage-ci-20261114/fingerprint-drift/`. The downloaded
archive and extracted site were removed without a browser workload retry.

## Permanent repair and removal

1. Firefox research owns the first failing filesystem transport operation.
   Capture the original MessagePort messageerror, sender and receiver lifecycle,
   and fork preopen operation. The ordinary sandbox uses FilesystemService,
   whose synchronous receive failures report reason=protocol, rather than the
   WorkspaceBridge path. Native .128 controls for inherited and newly published
   segments passed 72/72 with no messageerror. SAB announcements remain an
   unproved candidate. Reproduce on GitHub-hosted Ubuntu with the
   receipt-verified site and unchanged scenario before choosing a runtime fix.
2. WebKit research owns vanilla restart after config save. Capture the old and
   new process lifecycle, config evaluation, filesystem flush, preview request,
   and first exception before the readiness deadline. Hono's liveness excludes
   a whole-context shutdown but does not explain the stalled vanilla process.
   A fresh hosted run of the original failed source and producer passed the
   unchanged scenario after observer qualification. The original edit creates
   vite.config.ts; simultaneous config self-restart is unproved. Keep this as
   bounded non-reproduction rather than a demonstrated fence-overlap defect.
3. React bounds research owns raw-error source capture before worker error
   forwarding. Two normalized producer bundles
   match, but only the lower three frames map to EngineHost timer dispatch. The
   actual top throwing source remains unknown. Capture the original error and
   source URL/map at the exact optimizer failure, then demonstrate a regression
   and its repair. Do not infer J11, Waffle, lifecycle, or Rolldown memory as the
   cause from the current stack. Keep engine-host and diagnostic edits in the
   independent research lane.
4. Land the smallest demonstrated fix in its owning repository with a regression
   check. A dependency repair follows the normal release and consumer-pin path;
   this mitigation changes no dependency pins.
5. Remove each signature independently in the same repair PR or its consumer PR
   once the unchanged preservation scenario passes twice on GitHub-hosted runners
   for that browser with the matching quarantine entry disabled. Keep deadlines,
   site receipt verification, and all preservation assertions unchanged.
6. Delete the quarantine module and its CI switch once all three entries are removed.

The coordinator owns follow-through and accepts independent review before merge.
The implementation worker opens a draft early, runs local matcher and discovery
checks, then marks it ready so normal GitHub-hosted CI validates the real path.

### React reopening evidence gap

The first entry-absent hosted execution at head
`135564d953a5802e98523a71b2deb5a749d2fa7a` passed. The second, run 43608394922,
job 132533226013 on tested merge `9b43a0c6e30afa0eb5b1ddcb61e715fda9084602`,
failed during later React reopening after eviction. Initial React readiness
had passed. The later readiness candidate never completed, while Vite printed
ready and optimizer bundling and the preview stayed empty and loading. The
retained protocol has no bounds exception, CLOSED error or dev exit. Hono and
both filesystems remained ready and cleanup completed.

The cause remains unknown. A full exact-source local scenario and focused
reopening passed. Neither is hosted proof or evidence for a product repair.
The historical journal lacks request delivery and iframe document state, so it
cannot distinguish an unfinished dependency from delivery followed by a render
or preview acceptance failure. The bounded diagnosis is retained under
`/work/reports/goals/storage-ci-20261114/react-restoration-stall/REPORT.md`.

The ordinary optional observer now records request starts, response statuses,
completion and failure with per-page weak request identities. Frame identity,
URL, method, resource type and navigation context locate preview dependencies.
Events whose start was not observed carry `startObserved: false`; an absent
terminal event remains absent. No bodies, asynchronous response reads, worker
hooks, polling or new scenario timeouts are added. The failure snapshot reads
each iframe Document once and adds its URL, readyState and accepted-Document
identity. A null Document is never accepted. Historical report fixtures can
omit these diagnostic-only fields.

The real snapshot and emitted observer events have routed Chromium and WebKit
controls for delayed module release and rendering, loading and complete
documents, accepted and unaccepted documents, cross-origin null documents,
concurrent same-URL requests, failed requests, unknown starts and lost terminal
events. Suppressed lifecycle listeners are intentional diagnostic controls,
not naturally occurring browser losses. Evidence write errors stay blocking
without replacing a primary product error. These tests qualify observation,
not the cause of the React stall. Existing quarantine rejection and cleanup
failure controls remain required.

Readiness predicates, scenario order, checkpoint values, Document oracle,
success assertions and bounds are unchanged. Diagnostic-only consumers retain
the current React quarantine. Its separate removal remains with Storage PR 783
and requires two qualifying hosted WebKit passes; these diagnostics do not
satisfy that gate. Local controls and cleanup are retained under
`/work/reports/goals/storage-ci-20261114/react-hosted-diagnostics/`.

## Throughput checkpoint

The initial mitigation covers Firefox and vanilla. One bounded follow-up adds
only the first React optimizer signature. Research runs independently.
Local checks exercise historical protocols and counterexamples; CI provides the
real-browser validation. Do not spend another diagnosis round retrying controls
that have already passed locally.

Quarantine is the authorized temporary treatment of a known unrelated failure,
not a conclusion that a targeted retry has failed twice. The three signatures lack
an established transient cause that would make a retry a demonstrated repair.

## Mitigation verification

`scripts/storage-ci-quarantine.test.ts` replays all original protocols at their
source checkpoints. It rejects other checkpoints and browsers, unknown console
errors, altered transport or restart output, a missing or changed Hono control,
failed filesystem state, pending edits, ordinary assertions, and failed report
or summary writes. `checks/quality-storage-ci-quarantine.json` keeps these tests
blocking in Source quality. The existing browser manifest also selects the
producer when the quarantine helper changes.

Local verification runs the new tests with storage, discovery, and CI selection
tests, then checks discovery, lint, TypeScript, unused code, and duplicates.
GitHub-hosted CI validates the unchanged real scenarios on the verified site
when the draft becomes ready. A matching failure remains a recorded quarantine,
not a successful preservation result. The coordinator owns review and CI follow-up.
