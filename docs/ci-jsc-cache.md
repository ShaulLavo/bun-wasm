# JSC cache production

The JSC cache producer workflow runs on each main push outside the full CI
workflow's `push-main` queue. It resolves the existing effective JSC cache key
after preparing the pinned tools and patched sysroot. A source path filter cannot
represent that identity because effective compiler flags and tool receipts also
contribute to it. An unchanged identity restores and verifies without compiling JSC.

Full main and PR CI use the same setup and prebuild actions. All prebuild jobs
share a concurrency group equal to the complete existing cache key. Matching jobs
queue with `queue: max` rather than replacing pending checks. Different identities
can build independently. After acquiring the group, each job recomputes the key,
rejects a changed environment, and only then restores the cache. The extra setup
job makes the effective identity available before GitHub schedules the locked job.
It hands its sysroot to that job through a digest-checked, same-run artifact, so a
cold sysroot is compiled once per run even when a PR cannot publish shared caches.

The shared actions preserve the `jsc-prebuild-v2` key and compatible restore prefix.
Every restored tree still passes `check_jsc_inputs_stamp`, including artifact
digests, WebKit tree identity, and CMake toolchain checks. A missing cache retains
the existing cold build. A restored tree that fails verification fails the check.
Only main push jobs save verified caches. PR jobs can read main's cache but do not
publish shared prebuilds.

Cross-workflow reuse uses the existing cache, so no foreign run's transfer manifest
is accepted. Full CI packages a fresh transfer bound to its own run and commit,
then preserves the native consumers' manifest digest, archive checks, absolute
paths, and input verification. The standalone warmer skips that transfer and uses
a separate check name. The protected `JSC C/C++ prebuild` check still belongs to
full CI, and the aggregate gate also requires its identity job.

Cache eviction or a failed cache upload can cause a later fallback build. The lock
prevents overlapping builds for the same identity; it does not extend cache
retention or share untrusted PR caches with main.
