# CI cache retention

Status: Approved. Based on main `70ebce1a9602239ddc141bb8ab06ae34dfe484f3`.

On November 10, 2026, the main JSC prebuild saved at 10:07 UTC was absent at
12:31 UTC. Main recreated it at 13:04 UTC and a PR restored it at 13:05 UTC.
The supplied inventory held 10,961,105,675 bytes across 34 entries. PR-only
entries held 4,369,222,457 bytes. Rust object snapshots reached 1.2 GB each.

## Policy

Every cache writer, including composite actions and tool installers, now requires
a main push. PR restores keep their original paths and fallbacks. Browser apt
already followed this policy and stays unchanged. Release download tools still
populate their local download pool, but only main publishes that pool.

Rust objects use one immutable seed per job, platform, toolchain, and lockfile
revision, not per source commit. sccache gets a 512 MiB local object cap. A shared
save action also refuses seeds larger than 576 MiB, with room for directory
overhead. This catches oversized legacy restores even if no compiler starts.
Old object prefixes remain readable. An exact seed hit never creates another
archive. Source-only changes can miss some old project objects, but do not upload
another copy of the unchanged dependency objects.

Stable dependency seeds remove the measured per-SHA churn without a deletion
workflow or extra permissions. Existing cache entries are not deleted. Future
quota pressure and GitHub's expiry policy can still evict any cache.

The native Cargo target also keeps its first compatible snapshot. Its existing
source-specific primary key and native compatibility prefix stay unchanged.
A prefix restore still runs Cargo, native quality checks and fixtures, but no
longer publishes another full target after source edits. A complete miss can
seed the current identity after the existing blocking build steps. Learned
compiler objects continue to use their separate bounded snapshots.

On November 13, a main job restored the exact JSC generation at 04:43 UTC.
PR 692 and PR 695 missed that same key at 07:20 and 07:30 UTC; main rebuilt and
saved it at 07:40 UTC. The two host files are registered Browser guest inputs,
so their native selection is deliberate. The later inventory held 10.17 GB,
including two compatible native Cargo snapshots of about 1.78 GB each. This
establishes cache disappearance, with quota eviction the likely cause. Avoiding
another compatible Cargo upload reduces this pressure without changing JSC
identity, removing selected checks or deleting existing shared caches. It cannot
guarantee that GitHub retains a cache.

## Verification

The new policy regression failed on the original source with 16 passing and 22
failing tests. After the fix, 226 tests across nine nearby source-policy suites
pass. They cover PR, main, feature pushes, manual runs, exact hits, composite
writers, unchanged release inventories, and the real sparse-file size gate.
The quality-owned manifest registers the new test without changing a gate.

Actionlint, composite shellcheck after substituting GitHub expressions, repository
oxlint, and a strict TypeScript check of the new test pass. A full scripts typecheck
was not established with the throwaway dependency layout. Cache-linked Waffle
packages first lacked Playwright and xterm, and relocating them exposed duplicate
Wasi type identities. CI's staged dependency install remains the full type gate.

No native rebuild, remote test host, cache deletion, or permission change was
needed. Local fixtures clean up in finally blocks. Temporary dependency installs
and worktree symlinks are removed before handoff. Post-merge CI must confirm the
new main seed keys and subsequent JSC cache reuse under ordinary PR traffic.
