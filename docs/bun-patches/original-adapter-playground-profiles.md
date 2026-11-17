# Explicit playground program profiles

Classification: original host integration. No upstream implementation was copied.

The playground shares one lazy tools loader across its engine launchers. It retains
the verified compiled module for later lint/fmt commands, including while optional
CacheStorage persistence is pending or unavailable. A rejected load clears only its
pending result so a later command can fetch and verify again. The runner uses the
same loader factory. Fresh consumers still verify and compile persisted bytes.
The tools-cache controls cover concurrent loads, blocked and failed persistence,
integrity rejection and reload. No Waffle implementation or provider pin changes.

`web/src/playground/program-profile.ts` registers the playground's existing Bun
adapter and executable aliases only after checking the requested `split` or
`shared-group` profile against the prepared core with `isSharedGroupCore`.
`scripts/goals-matrix/` forwards that selection and checks the observed profile
at startup. Browser remains split; shared-group supports QuickJS, JSC and
SpiderMonkey when their matching profile pair is staged.

This makes the opt-in contract in `docs/shared-group-profile.md` explicit for
framework consumers. It uses existing module preparation, matched core and
companion validation, memory policy and launcher group routing. It changes no
upstream source, engine implementation, package API, memory limit or phase deadline.

The profile tests cover real split-pair preparation, actual executable registration
and both mismatches. The shared-profile check consumes the real CI-provided
paired program through the same preparation and registration path. Registration
alone establishes neither Rolldown capacity nor framework acceptance.

SpiderMonkey staging validates the original pair, core and native receipt
identities before publishing assets. Library bytes and header counts must be
positive safe integers, with valid SHA-256 digests in both native metadata
records. Equal missing or malformed identities cannot establish a match.

Angular template launches now select shared-group for the three Wasm engines
before loading. Explicit selections, Browser and unrelated defaults remain
unchanged. Goals use the same resolver, preserve omitted overrides across fleet
execution, and record mixed selection as template-default with actual startup
profile evidence. Missing shared assets fail before downloading program bytes.
Full site builds require complete shared-program inputs for published Wasm
engines; the existing staging verifier checks their real bytes and records.
No payload, backing, worker codec, allocator, memory budget, stack policy or
provider pin changes are part of this routing correction.

The common template catalog now declares the shared-worker requirement for
Vite 8 React, Vite 8 vanilla and Angular. The existing `templateProfile` resolver
reads that declaration, including in the sandbox's main demo. Vite 7 and other
ordinary templates retain split. Explicit split remains available for refusal
diagnostics; failed loading or execution never selects another profile. The
blocking shared browser check includes the catalog and both page policies as
inputs, so a policy-only edit still exercises matched-pair admission.

## iPhone shared-memory bounds

`web/src/host-memory-policy.ts` is an original host adapter. The playground and
sandbox select a 768 MiB QuickJS group maximum on iPhone. The cumulative member
allowance is also 768 MiB, as required by Waffle's policy validation. Stacks stay
8 MiB. Desktop keeps the existing 2 GiB group and 1 GiB member allowance.

Instrumented Chrome runs of the ordinary Angular and Vite React workflows reach
425,984,000 and 566,951,936 bytes of shared-memory capacity. Both complete all
nine phases. The 768 MiB maximum leaves about 42% above the larger measurement.
These are backing capacities, not resident-memory measurements. Native iPhone
workflow qualification is separate.

JSC uses a 1,280 MiB iPhone group maximum and retains its 1 GiB cumulative member
allowance. Its complete instrumented Chrome workflows reach 760,545,280 bytes for
Angular and 996,737,024 bytes for Vite React. The maximum leaves about 35% above
the larger measured capacity. Desktop keeps its original policy.

SpiderMonkey also uses a 1,280 MiB iPhone group maximum with the original 1 GiB
member allowance. Its complete Angular Chrome workflow reaches 1,033,568,256
bytes, leaving about 30% growth room. Desktop keeps its original policy.

The same host adapter sets the native Browser tool-memory fact for iPhone and
removes it from other engine environments. The byte-qualified Rolldown loader
adapter owns its tool maximum, recorded in
[Rolldown memory allocation](rolldown-initial-memory-adapter.md).
