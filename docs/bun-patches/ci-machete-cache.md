# Pinned Rust dependency checker cache

Class **Host feature**. Original CI adapter. No upstream code is copied or patched.

The native quality job caches only `CARGO_HOME/bin/cargo-machete` separately
from its broad Cargo seeds. Its exact key binds cargo-machete 0.9.2, runner OS
and architecture, the existing host-tool and effective native-environment hashes,
and the Rust toolchain and Cargo configuration files. The environment hash includes
the effective Rust and Cargo versions and compiler flags. There is no prefix restore.
The existing native recipe identities are unchanged.

Restore follows both broad seed restores so they cannot overwrite the tool afterward.
Setup always checks the executable's pinned version and retains the locked install
fallback with two jobs. A final version check prevents failed setup from publishing.
Only successful main push setup can save a missing exact cache. Every blocking
quality check still runs. No local compiler build or second tool install is added.

`scripts/ci-machete-cache.test.ts` runs the workflow's actual setup shell with a
controlled Cargo command. It covers an accepted executable, absent and stale tools,
install failure, and a wrong installed version. Workflow assertions cover exact-key
inputs, restore order, main-only publication, and the quality-owned check manifest.
Actual CI cache-hit and install-skip qualification is still required before claiming
any time saving.
