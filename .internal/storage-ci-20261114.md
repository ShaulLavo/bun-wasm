# Browser-native storage CI repair

Status: Approved. Owner: storage CI coordinator. Updated: 2026-11-14.

## Immediate mitigation

Run every existing storage scenario with its existing deadlines and verified site.
Only CI may quarantine the two historical preservation failures below. Match an
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

Chromium preservation, Chromium quota refusal, all unmatched Firefox and WebKit
failures, and every other required check remain blocking. Emit a warning and a
job summary for a quarantined failure. No broad continue-on-error, new retry,
timeout increase, engine change, Waffle pin change, or receipt bypass is allowed.
The quarantine admits a known failed scenario; it does not claim product success.

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

## Permanent repair and removal

1. Firefox research owns the first failing filesystem transport operation.
   Capture the original MessagePort messageerror or workspace-bridge exception,
   sender and receiver lifecycle, and fork preopen operation. Waffle .128's
   bridge catch discards the initiating exception and labels it messageerror.
   CLOSED and the deserialization text establish neither that mechanism nor
   the root cause. Reproduce on GitHub-hosted Ubuntu with the
   receipt-verified site and unchanged scenario before choosing a runtime fix.
2. WebKit research owns vanilla restart after config save. Capture the old and
   new process lifecycle, config evaluation, filesystem flush, preview request,
   and first exception before the readiness deadline. Hono's liveness excludes
   a whole-context shutdown but does not explain the stalled vanilla process.
3. Land the smallest demonstrated fix in its owning repository with a regression
   check. A dependency repair follows the normal release and consumer-pin path;
   this mitigation changes no dependency pins.
4. Remove each signature independently in the same repair PR or its consumer PR
   once the unchanged preservation scenario passes twice on GitHub-hosted runners
   for that browser with the matching quarantine entry disabled. Keep deadlines,
   site receipt verification, and all preservation assertions unchanged.
5. Delete the quarantine module and its CI switch once both entries are removed.

The coordinator owns follow-through and accepts independent review before merge.
The implementation worker opens a draft early, runs local matcher and discovery
checks, then marks it ready so normal GitHub-hosted CI validates the real path.

## Throughput checkpoint

One bounded mitigation PR covers both signatures. Research runs independently.
Local checks exercise historical protocols and counterexamples; CI provides the
real-browser validation. Do not spend another diagnosis round retrying controls
that have already passed locally.

Quarantine is the authorized temporary treatment of a known unrelated failure,
not a conclusion that a targeted retry has failed twice. The two signatures lack
an established transient cause that would make a retry a demonstrated repair.

## Mitigation verification

`scripts/storage-ci-quarantine.test.ts` replays both original protocols at their
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
