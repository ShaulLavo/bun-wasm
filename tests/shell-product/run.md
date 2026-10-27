# Real shell product browser test

This test runs the original product catalog's Vite React and Next 15 apps through
bash-web and guest Bun on one Waffle runtime. Native Bun only drives the test and
serves static test assets and recorded registry responses. It never executes the
framework, installs its dependencies, or answers preview requests.

## Inputs

Prepare a consumer directory containing the public `bash-web`, `bun-wasm`,
`waffle`, and `playwright` packages. Both consumers must declare the same exact
Waffle Git peer, resolve the same physical package, and retain the selected full
Git commits in `bun.lock`. Build the installed shell's worker, runtime-backed
shell guest, and utility guests. Do not use the shell CLI guest or edit package
manifests to bypass a peer mismatch. The browser command compiles no guest.

The Bun guest needs its producer `.build.json` and an independently accepted
receipt. The existing strict provenance parser validates its source commit/tree,
SHA-256, byte length, and required build fields. These inputs are borrowed
read-only. The test builds a new public-package browser host variant, not the
producer's original playground archive.

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
source env.sh
export SHELL_PRODUCT_INSTALL=/absolute/prepared-consumer
export SHELL_PRODUCT_SHELL_COMMIT=<full-shell-commit>
export SHELL_PRODUCT_WAFFLE_COMMIT=<full-shared-waffle-commit>
export SHELL_PRODUCT_GUEST=/absolute/producer/bun-browser.wasm
export SHELL_PRODUCT_RECEIPT=/absolute/producer/receipt.txt
export SHELL_PRODUCT_REGISTRY=/absolute/read-only-registry-replay
export SHELL_PRODUCT_REPORTS=/absolute/report-directory
# Keep TMPDIR physically short for Chromium sockets.
export TMPDIR=/work/tmp
bun /work/platform-production/heavy/current/run.js --class browser shell-product -- \
  bun web/tests/browser-shell-product.ts
```

`SHELL_PRODUCT_WAFFLE_COMMIT` always names the package peer retained in
`bun.lock`. `SHELL_PRODUCT_WAFFLE_HOST_COMMIT` names the Git source archived into
the physical runtime package. It defaults to the explicit package peer for
ordinary same-ref preparation. Both commands require full lowercase commits.
Preparation retains `.shell-product-host.json` beside `bun.lock`, recording the
Shell, peer, host, and network input selections. The browser checks that record
against the requested refs and installed network input before bundling. A host
ref different from the package peer is an explicit host variant. It does not
change package pins or qualify package-consumer adoption at the host ref.

`PLAYWRIGHT` can select an already installed driver. Without it, the driver is
loaded from the prepared consumer. `SHELL_PRODUCT_TIMEOUT_MS` sets each command,
listener, and DOM deadline, defaulting to 90 seconds. An overall deadline stops
the run after 20 minutes.

Each stage writes a pass, fail, or blocked row to `scoreboard.json` immediately.
Any failed or blocked row makes the command exit nonzero. A missing public
standalone `tail` leaves only the build pipeline blocked. It is never replaced
with a Bun script. When the installed shell exports `bash-web/utilities/tail`,
the test installs that real WASM utility and runs `bun run build | tail -n 8`.

By default, the command checks the installed guest apps, loaded service-worker
preview DOM, three start/stop cycles, real terminal interruption and prompt recovery,
redirection, exit status and boolean lists, cwd, package tools piped to grep, and
an inline `PORT=3001` override. Raw terminal output and screenshots are retained.
Task asset/registry servers, browsers, copied app sources, and scratch are removed
on completion or interruption. The prepared packages and shared caches remain.

## Select the workflow

`SHELL_PRODUCT_RUN` selects a fixed app and stage scope. An unset value selects
`full`. Unknown values, including empty strings, unsupported apps and arbitrary
stage selections, fail before report, scratch, registry or browser setup.

| Mode | Apps | App stages |
| --- | --- | --- |
| `full` | Vite React, Next 15 | All 28 stages |
| `next-install-only` | Next 15 | Install |
| `vite-dev-ctrl-c` | Vite React | Install, dev preview, first Ctrl-C |
| `next-dev-ctrl-c` | Next 15 | Install, dev preview, first Ctrl-C |

With the same current verified prepared packages, guest, receipt and replay
inputs, run a focused development cycle:

```sh
SHELL_PRODUCT_RUN=vite-dev-ctrl-c SHELL_PRODUCT_REPORTS=/absolute/vite-dev-reports \
  bun /work/platform-production/heavy/current/run.js --class browser shell-product-vite-dev -- \
  bun web/tests/browser-shell-product.ts

SHELL_PRODUCT_RUN=next-dev-ctrl-c SHELL_PRODUCT_REPORTS=/absolute/next-dev-reports \
  bun /work/platform-production/heavy/current/run.js --class browser shell-product-next-dev -- \
  bun web/tests/browser-shell-product.ts
```

Each dev mode records six rows: setup, guest install, real dev preview, one
Ctrl-C, global cleanup and replay/network. Installation must exit 0 before dev
can start. Ctrl-C requires the actual entered foreground server and expected
live listener. It retains terminal interruption, status, job-owned worker and
baseline checks, listener removal, stopped-preview HTTP502 and `PROMPT_USABLE`.
There are no restarts, builds or later shell commands in these modes.
Use a separate report directory for each invocation. A passing focused run
proves only its selected cycle, not the full workflow.

A dev page HTTP500 remains a failed page row. If the real server remains live,
Ctrl-C can independently pass, while the overall command still exits nonzero.
A missing listener or exited server blocks Ctrl-C; a failed interruption is
not retried. These modes retain the normal provenance, one-runtime, deadline
and final global zero-worker/listener guards.

## Next installation only

With the same prepared inputs, select only Next's guest installation:

```sh
SHELL_PRODUCT_RUN=next-install-only \
  bun /work/platform-production/heavy/current/run.js --class browser shell-product-next-install -- \
  bun web/tests/browser-shell-product.ts
```

This mode runs shared setup, opens only `next-15-app`, and requires the actual
guest `bun install` to exit 0. It then checks guest worker/listener cleanup and
registry replay. It does not run Vite, development servers, builds, or the later
shell checks. Only the selected install stage gets a row or a missing-stage
block. Shared setup, cleanup, and network rows remain required for success.
The command keeps the same guest provenance, replay, one-runtime, deadline,
and resource-cleanup guards.

`run.json` records `mode`, `apps`, and expected app `stages` for every mode before
staging begins, including runs that fail setup.
A passing `next-install-only` scoreboard proves only this focused acceptance,
not full workflow completion. Keep its report directory separate from full runs.

## Optional package preparation

After Shell publishes a genuinely aligned commit, the preparation helper can
create an empty, explicitly owned installation. It packs this checkout's public
Bun package, ignores dependency lifecycle scripts, checks both exact Waffle
peers, and builds only Shell's necessary guests. After installation, it replaces
`node_modules/bun-wasm` with a fresh extraction of the just-packed archive before
checking Bun's peer. Cached installed files are not authoritative. Removing the
old consumer entries before extraction breaks cache hardlinks, so private caller
edits cannot change the shared package cache. The cache itself stays untouched.
It archives the selected host commit from `SHELL_PRODUCT_WAFFLE_REPOSITORY`, a
read-only local Git repository, into the owned Waffle package directory. Only
`network.wasm`, `network.sha256`, and `network.input-hash` are borrowed. The
selected tree's `tooling/build-network.ts --verify` checks network source inputs
and WASM integrity before `prepare.ts` emits fresh JS from that tree. Both
subprocesses receive `WAFFLE_NETWORK_PREBUILT=1`, so invalid network inputs are
fatal and never trigger a network build. No borrowed `dist` is used. This binds
exact network inputs and integrity, not a historical producer receipt. Build outputs
use the installation's own Cargo target. Failed or interrupted preparation
sets cancellation before stopping its process groups, refuses new subprocesses,
waits for the main flow to finish, then removes the owned installation.

Set the inputs above, `SHELL_PRODUCT_WAFFLE_REPOSITORY` to the read-only local
Waffle Git repository, and `SHELL_PRODUCT_PREPARED_WAFFLE` to the read-only package
containing the three network files. Choose an empty `SHELL_PRODUCT_INSTALL` under
`/work/tmp`, then run through the host's canonical build queue:

```sh
bun /work/platform-production/heavy/current/run.js --class build shell-product-prepare -- \
  bun web/tests/browser-shell-product-prepare.ts
```

Successful preparation retains that installation for the browser command.
Install caller teardown before preparing and running it together, removing only
that explicitly owned installation after browser consumers have stopped. This
helper does not select package commits or repair a peer mismatch.
