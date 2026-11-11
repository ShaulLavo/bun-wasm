# JSC artifact inventory

The ordinary and shared producers use `scripts/ci-jsc-artifact.ts` only at the
artifact pack point. Their full caches, builds and verification stay unchanged.
The inventory excludes ICU producer sources/data/tarballs, Ruby gems, shared
libc++ build/LLVM source trees, and named producer logs outside qualified roots.

All `build/jsc` and WebKit files, including sparse Git state, remain. Guest source
receipts recursively hash `build/jsc` through an actual helper include root, so
removing objects, Ninja metadata, CMake files or header maps would change that
contract. The packer checks stamp members, CMake metadata, helper include and
forced-include paths, and retained symlink closure before streaming a NUL-delimited
member list to tar. No staging tree or temporary list is written. Intentionally
absent search paths remain absent.

Tests import real archives, compare the same synthetic producer's qualified JSC
and tools source manifests, exercise offline sparse Git patch verification and
the real CMake preflight, and reject missing or excluded dependencies. They do
not compile JSC. Hosted CI must validate real consumers and measure real artifact
sizes; category logs report regular-file bytes and total compressed bytes.

## Approved follow-up measurement

`jsc/build-libcxx.sh`'s `libcxx_source_tree` still uses `git write-tree` without
`--missing-ok`, while `jsc/common.sh`'s WebKit verifier uses `--missing-ok` to
avoid fetching unrelated blobs from a sparse, blobless checkout. This is a
suspected producer/cache cost, not a measured regression. This artifact change
already excludes the LLVM checkout, so its upload savings do not depend on that
question.

Reproduce with a tiny local shallow, blobless sparse repository and an unavailable
origin, following the real offline fixture in `ci-jsc-artifact.test.ts`. Run the
actual libc++ verifier prefix through `libcxx_source_tree` with its two patch
files, compare default `write-tree` with `--missing-ok`, and record missing blobs,
object counts and the tree ID. Preserve worktree, untracked-source and patched-tree
checks. No LLVM production build is needed for this measurement. Only then choose
a fix and its cold/warm cache proof. Changing this script currently changes both
profiles' JSC input hashes, so include that invalidation cost in the decision.
