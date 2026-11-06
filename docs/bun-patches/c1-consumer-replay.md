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
  tree, repository, target branch, pull request number, and the unchanged
  independent review.
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
   merged into the harness target branch `consumer/runtime110` of the named
   repository at exactly the harness commit, from exactly the reviewed
   candidate head; GitHub's commit objects give the candidate and merged
   trees, which must be equal; and that branch's head is still the harness
   commit. The contract records the target branch as its own strict field
   (`harness.targetBranch`), and no other value parses. Main is never read:
   it keeps moving (installer, locks, product), and those commits can neither
   admit a harness nor enter a replay, because the diff from the product
   source must still touch consumer files only. The same harness changes
   reach main later through an ordinary pull request.

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
- Every successful GET the page makes is checked against the sealed web root
  and named by URL when it is refused. The `blob:` content URLs the browser
  engine gives each guest module, cycle members included, are made by the page
  itself rather than loaded from the server, and are counted in `browserMade`
  instead. They never become `loaded` rows, never bind to a member and never
  satisfy coverage. Server answers, including `.gz`/`.br` representations, are
  unchanged.
- Chromium cleanup stops the web server's and the browser's process groups
  with the shared `stopProcessGroup` utility and reads `browserClosed` only
  after the browser group is empty. Playwright's own kill waits only for the
  browser leader, so helpers of that group could still exist when it
  returned. `scripts/consumer-process-groups.ts` enables Linux child
  subreaping before cleanup and reaps only adopted zombie grandchildren in
  the owned detached groups. PID birth identities prevent reuse; direct-child
  exit events remain Bun's, and unrelated groups are never reaped.
- `scripts/tls-qualification.ts` tags failures by phase and keeps the first
  setup or exercise error when cleanup also fails. Every phase keeps its
  message, stack, errno fields and nested errors. Only registered run secrets
  are redacted: the database password, the relay credential, the relay
  token-signing key and each minted token, registered where the driver creates
  or receives them, in their raw, JSON-escaped, URL-encoded and byte-rendered
  forms, including Buffer and typed-array inspection. Both the PC stderr
  observer and remote command owner redact complete values across chunk
  boundaries before retaining a bounded tail. TLS private keys stay on the
  Pi, where their redaction is registered locally. The browser prelaunch check
  binds the running harness identity separately from the delivered product
  identity. `scripts/tls-qualification-lifecycle.ts` and
  `scripts/tls-qualification-context.ts` are bundled inputs of the sealed TLS
  page and are unchanged.
- `tests/servers/tls.ts` (the Pi PostgreSQL owner the driver sends to the Pi,
  outside every producer stage and the sealed page) keeps each Podman
  failure's subcommand, exit code or signal and stderr, removes the container
  and the volume independently (the volume without `--force`, so Podman
  itself refuses one still in use), and prints its failures on stderr.
  `podman volume rm` takes no `--ignore` (Podman 5.4.2 on the Pi exits 125 on
  it), so the volume step asks `volume exists` first: an absent volume, from
  partial setup or an earlier removal, is left alone; a present one gets plain
  `volume rm <name>`, whose in-use refusal (exit 2) keeps its stderr; absence
  is checked again afterwards. Images are never touched. The
  driver records that stderr, redacted, in the remote cleanup ledger row. The
  Pi lane lease has its own detached process group. Cleanup closes stdin,
  then ends and reaps the entire group even if a stopped descendant prevents
  normal EOF handling. The original timeout or unreconciled-resource error
  remains a failure after local termination. An unreconciled remote fixture
  is left as it is, named in the ledger.
- The sealed TLS page keeps a guest's stdout in a closure, drops its stderr
  and throws one generic error for a nonzero exit. `web/tests/tls-relay-browser.ts`
  observes the guest from the host instead, without changing any served byte:
  a Playwright init script, installed before the page's own scripts, adds one
  more `message` and `error` listener to every page-level `Worker` and sends
  the fields of waffle's `RuntimeWorkerMessage` that carry evidence (phase,
  stdout, stderr, exit, error, cleanup-error) to a host binding in order. The
  page's own handlers still receive every event. Its positive control is the
  guest root worker's own `worker-start` phase, which waffle posts on the same
  channel before the guest runs: the relay token is issued only after that
  control was seen for the current case, so no PostgreSQL connection is made
  through an unarmed observer. A failed case becomes `TlsGuestCaseFailure`
  with the page's error as its cause and a `guest` field: the case, each
  worker's phases, exit and error messages and redacted stdout and stderr
  tails (secrets removed before bounding), the page's sent count and any
  records the host did not receive.
