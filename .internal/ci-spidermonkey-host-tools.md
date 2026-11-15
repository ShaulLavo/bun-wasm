# Shared SpiderMonkey host tools

Status: Approved.

The shared library producer failed before compilation in run 43649601630,
job 132630415884. Target WASI SDK Clang 23.1.0 worked, but the pinned Mozilla
configure rejected host Clang 18.1.3. It requires Clang/LLVM 19 or newer.

The producer installs Ubuntu's explicit `clang-19` and `llvm-19` packages.
Official noble-updates metadata lists version `1:19.1.1-1ubuntu1~24.04.2`
for both packages in universe:

- [clang-19](https://packages.ubuntu.com/noble-updates/devel/clang-19)
- [llvm-19](https://packages.ubuntu.com/noble-updates/llvm-19)
- [Clang file list](https://packages.ubuntu.com/noble-updates/amd64/clang-19/filelist)
- [LLVM file list](https://packages.ubuntu.com/noble-updates/amd64/llvm-19/filelist)

The install step selects `/usr/bin/clang-19`, `/usr/bin/clang++-19` and
`/usr/bin/llvm-readobj-19` through their unversioned links inside the disposable
Ubuntu job. The existing mozconfig uses absolute `/usr/bin/clang` and
`/usr/bin/clang++`, so changing PATH alone would leave the rejected compiler.
This setup applies to the Ubuntu PC guest and hosted fallback. It changes
neither the accepted VM base nor engine source.

After `env.sh`, the native-input step checks the actual absolute host compiler
paths and the PATH-selected `llvm-readobj` for major version 19. Its hash binds
their resolved paths, file bytes and version output, plus the existing package
inventory, target SDK, sysroot and other tools. A missing or failing input
command stops the hash pipeline. A tool upgrade changes the native-input hash;
the setup change also changes the existing producer recipe hash. The existing
exact cache key therefore causes one legitimate migration without a new key
scheme or a fallback to the old compiler's objects.

`scripts/ci-spidermonkey-prebuild.test.ts`, already owned by
`checks/quality-ci-spidermonkey-prebuild.json`, executes both maintained shell
steps against disposable tool fixtures. It checks the install command and real
symlink behavior, package-install failure, version rejection, tool-byte and
version changes, missing tools and fingerprint-command failures. Its recipe
controls also mutate the package selection and compiler-link target.

Fixture-owned tools have rejecting fallback entries before ambient PATH tools.
Valid ambient LLVM 19 and package-query decoys reproduce hosted-runner behavior,
so deleting a selected fixture cannot accidentally use the machine's real tool.
The production setup and fingerprint commands remain unchanged.

No product or native engine build is needed for these controls. Actual Ubuntu
installation and the next producer configure remain integration checks.
