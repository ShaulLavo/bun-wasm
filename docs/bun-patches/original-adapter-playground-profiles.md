# Explicit playground program profiles

Classification: original host integration. No upstream implementation was copied.

`web/src/playground/program-profile.ts` registers the playground's existing Bun
adapter and executable aliases only after checking the requested `split` or
`shared-group` profile against the prepared core with `isSharedGroupCore`.
`scripts/goals-matrix/` forwards that selection and checks the observed profile
at startup. Browser remains split; shared-group is restricted to QuickJS and JSC.

This makes the opt-in contract in `docs/shared-group-profile.md` explicit for
framework consumers. It uses existing module preparation, matched core and
companion validation, memory policy and launcher group routing. It changes no
upstream source, engine implementation, package API, memory limit or phase deadline.

The profile tests cover real split-pair preparation, actual executable registration
and both mismatches. The shared-profile check consumes the real CI-provided
paired program through the same preparation and registration path. Registration
alone establishes neither Rolldown capacity nor framework acceptance.
