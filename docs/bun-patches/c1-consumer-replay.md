# C1 consumer replay harness

Original repository adapter, not copied from Bun, Node, WebKit or another
upstream. It changes no vendored source and no product build input.

## Two identities

- **Product**: one admitted sealed delivery, exactly as produced. The replay
  contract (`scripts/c1/replay.ts`, schema `bun-wasm.c1-replay/1`) names its
  `DELIVERY.json`, the independent parent intake, the producer's own CONFIG,
  source commit and tree, release tuple and member count. Admission re-hashes
  every member with its sealed mode. Nothing is relabeled, rebuilt or resealed.
- **Consumer harness**: the merged, reviewed checkout whose controller and
  drivers run the consumers. The contract names its checkout, merged commit and
  tree, repository, pull request number, and the unchanged independent review.
  A separate correction record binds the reviewed source, the final candidate,
  every resolved finding, the exact correction diff, and its test evidence.

Each replayed consumer receives `bun-wasm.c1-replay-handoff/1`: the pinned
contract file, the harness identity, the host tools, and the product view of
the delivery (the unchanged `bun-wasm.c1-handoff/1` shape with the replay's
fresh output and browser roots). Consumers re-derive it from the contract,
the sealed delivery and the intake. A bare product handoff is refused.

## Harness guard and trust chain

`scripts/c1/harness.ts` admits the harness before any setup:

1. The controller runs from the harness checkout, clean, at the named commit.
2. The product commit is an ancestor with its stated tree, and every path the
   harness changes is in `CONSUMER_HARNESS_PATHS`, a list of exact files.
   Producer stages, publication, the TLS page builder, guest and host sources,
   build scripts, pins, locks, patches and native inputs are outside it.
3. No changed path is an input the sealed TLS page bundled, read from the
   sealed page receipt. The TLS consumer later re-hashes every bundled input in
   the staged harness checkout.
4. The independent review is pinned by bytes and names the source it reviewed.
   Its original verdict and findings stay unchanged. A separately pinned
   coordinator reconciliation must resolve every finding exactly once, bind
   the exact consumer-only diff to the final candidate, and pin the test logs.
   A finding-free review permits no subsequent source changes.
5. GitHub's public REST answers, read unauthenticated, show the pull request
   merged into `main` of the named repository at exactly the harness commit,
   from exactly the reviewed candidate head, and GitHub's commit objects give the
   candidate and merged trees, which must be equal.

The reconciled candidate tree must equal the merged tree. The merge is public,
and both the correction diff and the diff from the product touch consumer
files only. No approval event, signature, credential, or fabricated approval
is required. A different merge tree refuses rather than silently extending
the review to unrelated changes.

## Host tools

The TLS consumer's direct host executables (`mesh`, `flock`, `sh`, `cat`,
`findmnt`, `ps`, `tar` and its `gzip` helper) are declared in the contract at
resolved absolute paths with bytes, SHA-256 and the first line of their
version command. The controller checks each in the consumer environment; a
tool its PATH also finds must resolve to the declared file. Consumers call
them by those paths, and `tar` is given `--use-compress-program` with the
declared `gzip`. Product tools (`bun`, `git`, `bash`) stay in the product input
manifest. Outer runner tools, Pi tools and container tools are not host tools
of this consumer.

## Replay scope

`bun scripts/c1-controller.ts replay REPLAY.json --execute SHA256` reruns the
five-owner Chromium surface and TLS `pg-early` only. Native QuickJS and JSC are
never rerun. The replay contract pins their original `result.json` files by
path, size, and hash before setup, and checks those same identities again
afterward. Relay stays not run. The first qualification's output, handoff and
record are also pinned and rechecked after the run. A driver that fails keeps its first error and its
whole `result.json`, or why none is readable.

## Failure evidence

- `scripts/io-resource-context.ts` keeps Chromium observations captured before
  a failure and reports the first execution error; later cleanup or empty
  loaded validation errors are diagnostics.
- `scripts/tls-qualification.ts` tags failures by phase, keeps the first setup
  or exercise error when cleanup also fails, and prints messages only for
  credential-free pre-ledger phases. The browser prelaunch check binds the
  running harness identity separately from the delivered product identity.
  `scripts/tls-qualification-lifecycle.ts`
  is a bundled input of the sealed TLS page and is unchanged.
