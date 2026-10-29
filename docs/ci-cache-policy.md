# Shared CI build caches

Heavy build archives are written only by `push` runs on `refs/heads/main`.
Pull requests restore them and run every selected build and check, including when
no compatible archive exists. A pull request never saves a cold full build.

This covers native source checkouts, the native quality checkpoint, native Cargo
targets, the JSC prebuild, JSC Cargo targets and the bash-web shell build. Restore
keys, input hashes, build commands and required checks keep their existing guards.
Validated main checkpoints can still be saved before a later unrelated failure.
Exact hits are not saved again. Bash-web uses separate restore/save actions so
its post-job action cannot create a large PR-scoped archive.

GitHub restricts a pull request's merge-ref cache to that pull request. Copies
stored there consume the repository's cache allowance but cannot warm other PRs.
Main archives can be restored by every PR. Large merge-ref copies can evict main
and turn an ordinary change into a full native/JSC rebuild.

## Verify the policy

The Quality owner discovers `scripts/ci-cache-policy.test.ts`. It parses the actual
workflow, resolves saved primary-key references, rejects automatic heavy saves,
and checks cold-main, cold-PR, feature-push and cancellation cases. Existing CI
controls retain producer readiness, exact/prefix restore behavior and blocking
gates.

Policy tests do not prove remote hits. After landing, inspect the next two real PR
runs for cache keys, hit or compatible restore messages, and save-step skips.
Record each run's source commit and job ID. Measure cache usage against the
10 GiB allowance. Do not infer a workflow speedup from one cached job.

Old in-flight workflows retain their old save conditions. Inventory those writers
without cancelling another lane's jobs. Cache cleanup uses reviewed exact IDs,
with key, ref and size recorded before deletion. Preserve main archives, active
compiled warm caches and unrelated cache categories. Recheck the inventory after
deletions because old workflows may replenish PR copies.
