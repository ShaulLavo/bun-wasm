# PC CI runner adapters

Classification: Original adapters. The controller, VM lifecycle, authority policy
and local cache backend are original TypeScript. They do not patch the runner.

The upstream contract is GitHub Actions Runner v2.338.2. Its relevant paths are
`src/Runner.Worker/JobExtension.cs`, `ActionManager.cs`, `JobHookProvider.cs`,
`Handlers/ScriptHandler.cs`, and `src/Runner.Common/HostContext.cs`.
`scripts/ci-runner/source-proof.ts` verifies the pinned source ordering and bytes.

The settings reader also follows `src/Runner.Common/ConfigurationStore.cs` and
`src/Runner.Sdk/Util/IOUtil.cs` at that revision. Stock `SaveSettings` writes
`.runner` through `IOUtil.SaveObject` with `Encoding.UTF8`, including its byte
order mark. The guest removes that single leading preamble before parsing JSON
and still requires boolean `ephemeral` and `disableUpdate` fields to be true.
This is an original file reader, not a runner patch.

The repository-scoped controller starts a disposable Ubuntu VM only for an
eligible queued job. The installed heavy runner accounts for the entire VM,
including action preparation and Node processes. The administrator pre-job hook
is released only after host-side API checks bind the actual job, run, attempt,
head and registered runner to the trusted repository event. Forks and manual
runs retain hosted execution. The workflow guard is supplemented by this host
authority check because a fork can edit its own workflow.

Queued admission does not reserve GitHub queue order. A session binds only its
registered runner ID. Authenticated run/attempt hints locate the supported REST
`actions/runs/{run_id}/attempts/{attempt_number}/jobs` inventory. Two complete
inventories, bounded to 100 jobs each, must identify the same unique assignment
to that runner. Exact job, current run and trusted-source reads follow each
inventory before release. A different eligible job or trusted run can therefore
use the VM. Incomplete, ambiguous, stale or untrusted API facts stop it. Result
receipts retain the approved public job, run, attempt, head and runner identity.

Before the hook, stock runner preparation downloads and extracts action archives
inside the private VM. Container setup and workflow execution follow the hook.
A rejected or uncertain assignment stops the VM instead of returning control to
later always steps. Cleanup verifies the exact owned service and heavy slice
are empty before deleting registrations, keys and job backing.

Registration uses the existing host GitHub login to fetch short-lived material.
No personal access token is created or copied into the guest. Runner credentials
remain on disposable job backing. The service stays inactive without an exact
reviewed-source digest; the repository routing switch defaults disabled.

The guest uses stock WorkFolder `/work/w`, workspace
`/work/w/bun-wasm/bun-wasm`, and runner temp `/work/w/_temp`. A guest-private bind
and TMPDIR can use `/work/t`. Logical paths remain stable between private jobs;
input stamps are verified rather than rewritten.

The private Listener environment includes standard system sbin directories so
JSC identity, native quality and Rust jobs can find installed `ldconfig`.
This preserves tool inventory and fingerprints across all job entry points.

VM requests use the installed heavy runner's public settings-home option with
the same production queue and policy. The CI snapshot reserves the known 8/10
GiB VM budget without raising configured ceilings; insufficient ceilings fail.
Other machine policy is preserved. `systemd-run` is an OS dependency rather than
an npm binary, which accounts for its Knip binary exclusion.

`scripts/ci-runner/cache.ts` implements immutable, checksum-verified local
snapshots for existing cache keys and prefixes. It restores into job-private
paths and publishes only for main pushes. Hosted cache behavior and all existing
compiler, receipt, checksum and blocking-check guards remain in place.

Local snapshots are limited to 32 GiB and 256 entries on the 128 GiB cache disk.
Successful restores update the snapshot directory's last-use time without
changing archived files. Publication removes the least recently used snapshots
to leave room for the incoming archive, and skips an archive larger than the
budget. A process-scoped filesystem lock serializes cache operations and permits
reclaiming interrupted staging after cancellation. The complete Web unit install
publishes the PC Bun dependency snapshot on main. Hosted quality retains its
existing GitHub publisher.

The cache CLI accepts absolute, separate storage and job directories so its
behavioral tests also run on hosted machines. It rejects whole-job snapshots,
outside job paths and cache storage aliases. The VM lifecycle fixes production
directories under `/work`; the CLI does not change those locations.
