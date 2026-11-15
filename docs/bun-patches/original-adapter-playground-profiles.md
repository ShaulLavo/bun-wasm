# Explicit playground program profiles

Classification: original host integration. No upstream implementation was copied.

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
