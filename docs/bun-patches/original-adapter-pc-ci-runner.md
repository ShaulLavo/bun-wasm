# PC CI runner adapters

Classification: Original adapters. The controller, VM lifecycle, authority policy
and local cache backend are original TypeScript. They do not patch the runner.

The upstream contract is GitHub Actions Runner v2.338.2. Its relevant paths are
`src/Runner.Worker/JobExtension.cs`, `ActionManager.cs`, `JobHookProvider.cs`,
`Handlers/ScriptHandler.cs`, and `src/Runner.Common/HostContext.cs`.
`scripts/ci-runner/source-proof.ts` verifies the pinned source ordering and bytes.

The repository-scoped controller starts a disposable Ubuntu VM only for an
eligible queued job. The installed heavy runner accounts for the entire VM,
including action preparation and Node processes. The administrator pre-job hook
is released only after host-side API checks bind the actual job, run, attempt,
head and registered runner to the trusted repository event. Forks and manual
runs retain hosted execution. The workflow guard is supplemented by this host
authority check because a fork can edit its own workflow.

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

`scripts/ci-runner/cache.ts` implements immutable, checksum-verified local
snapshots for existing cache keys and prefixes. It restores into job-private
paths and publishes only for main pushes. Hosted cache behavior and all existing
compiler, receipt, checksum and blocking-check guards remain in place.
