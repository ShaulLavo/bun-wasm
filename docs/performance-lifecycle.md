# Framework lifecycle measurements

The lifecycle adapters live beside the strict interpreter replay tools in
`scripts/performance/`. They measure the exact Next and Vite React starters.
Replay result equality remains specific to interpreter tracing.

The initial implementation depends on PR 630 at
`73986d5faae6a00130ee7b3be0dd4a22a0881705` and PR 624 at
`c306727b894544e357284d1b6a2dc36b6b28b0c1`. The latter supplies Waffle 0.0.122.
Both heads were integrated into the implementation branch while pending CI.

Next ends at successful process completion with expected build outputs.
Vite ends after rendering the starter and changing its counter from zero to one.
Installation and native preview-browser launch precede timing. Mutable build and
dependency-cache outputs are excluded explicitly from immutable input identity.

PC campaign results are nonquiet experiments. Headless runs are ineligible for
headline performance claims. Timing validity, workload outcome, and observer
coverage are recorded independently. Missing counters remain null with reasons.
