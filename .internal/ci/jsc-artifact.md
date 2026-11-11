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
