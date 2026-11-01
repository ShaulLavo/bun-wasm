# SpiderMonkey G3

Status: Approved work, blocked before native hello. This draft is not ready to merge.

## Observed blocker

The full native runtime reaches its shared JavaScript bootstrap, then fails while
loading `formats.ts`. Its JSON5 formatter contains Unicode `ID_Start` and
`ID_Continue` property escapes. The retained no-Intl SpiderMonkey library rejects
that literal with `SyntaxError: invalid class property name in regular expression`.
The native command returns 70 before user code runs.

At Mozilla revision `a5df22d986d4b626f771b4f8885241941601c35c`,
`js/src/irregexp/imported/regexp-parser.cc:2519-2535` rejects all property class
names when `V8_INTL_SUPPORT` is disabled. That follows the approved
`--without-intl-api` profile. Adding FormatJS does not make rejected regex literals
parse. This needs a design decision about native Unicode property support before
more implementation rounds.

The worker stopped without weakening the shared runtime regex, adding an engine
source rewrite, changing the Engine trait, or rebuilding Mozilla with a new profile.

## Preserved work

The draft adds a rooted JSAPI shim, a Rust Engine adapter, native paired-program
registration, build recipes, input verification, and receipt plumbing. G2's original
shim remains unchanged behind its standalone feature. The production core needed
one additional measured libc export, `getpid`, from its existing emulation library.
The common core and production side linked and initialized through the real host.

The experimental commands used uncommitted source and do not have canonical engine
or guest build receipts. The draft's final source is not claimed as those executed
bytes. The report retains the command scripts, execution source copies, logs,
artifact hashes, and the source diff. No comparison or producer admission is claimed.

## Remaining verification and known incomplete details

Native hello, eval, modules, CommonJS, serve, and spawn are not accepted in either
tier. The namespace promise, dynamic import, async-context queue, rejection tracking,
native finalizers, external buffers, interruption, and stack behavior need full
runtime tests after bootstrap can run. The draft still clamps nonpositive classic
script line numbers rather than preserving the Engine contract's CommonJS offset.
External-buffer identity and direct built-in transfer protection need review.
These are unfinished work, not proven implementations.

The next worker must first revisit the no-Intl design with the coordinator. Reuse
`spidermonkey/prepare-engine-inputs.ts` to verify the original G1 and G2 inputs. Do not
relabel their receipts or start G4, a producer generation, or browser registration.
