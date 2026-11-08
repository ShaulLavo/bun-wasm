# SpiderMonkey framework runner

Status: Approved. The goals runner follows the actual playground engine registry for
registration, status names and core filenames. Paired side filenames come from the
shared engine profiles. This includes explicitly selected SpiderMonkey without
registering Hermes, changing the default selector, or changing supported publication.

A missing whole engine is still a discovery result, not a runnable cell. A staged
partial pair is a preparation error. Both SpiderMonkey files participate in the
embedded-host, manifest and byte fingerprint check. Asset preparation includes the
optional pair before the ordinary playground build embeds its fingerprints.

`source env.sh && bun test scripts/goals-matrix/engines.test.ts` covers discovery,
plain/compressed assets, cleanup, partial pairs, stale bytes, and running status.
All four tests fail before the runner correction against the actual registered
SpiderMonkey source, not a replacement loader.

Development evidence belongs in
`/work/reports/goals/engines/spidermonkey-frameworks/`. The canonical goals table
remains frozen and owned by its existing lane. Retained SpiderMonkey components
have separate core and side source identities; a current host build is not a
current full guest build. No release, JIT or general parity claim follows from
these runner corrections.
