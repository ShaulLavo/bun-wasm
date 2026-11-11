# Playground program profiles

The playground defaults to the `split` program profile, including the Browser engine.
The opt-in `?engine=quickjs&profile=shared-group` and
`?engine=jsc&profile=shared-group` selections require matching shared-group core
and companion artifacts. The Browser and experimental SpiderMonkey playground
engines do not accept `shared-group`.

Profile selection checks the actual prepared core before registering Bun or its
Node aliases. Replacing ordinary artifacts with a shared pair without selecting
the profile fails startup. Selecting shared-group with an ordinary pair also
fails startup. The existing matched-pair verification and Bun memory policy
still apply.

Framework qualification passes `--profile=split` or `--profile=shared-group` to
`scripts/goals-matrix/fleet.ts`. Shared qualification selects only QuickJS and
JSC. Startup evidence records the running profile and refuses a mismatch. Profile
selection does not establish parser, worker, or framework compatibility. Those
still require the unchanged lifecycle checks.
