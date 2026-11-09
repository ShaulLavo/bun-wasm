# Summarize existing framework evidence

Use a read-only view when independent runs have different runner sources or deadline
policies. This does not combine them into one executable campaign.

```sh
source env.sh
bun scripts/goals-matrix/view.ts --output=/absolute/new-view-directory \
	--frameworks=nuxt,astro,react-router,solidstart,tanstack-start,angular \
	--browsers=chrome,firefox,safari --engines=browser \
	/absolute/pc/TABLE.json /absolute/native/TABLE.json
```

The output directory must not exist. Its parent must exist. The command creates
`VIEW.md` and `VIEW.json`, never changes an input, and starts no browser or framework.
Without selection flags, the visible cells use the current catalog. Flags accept
comma-separated current framework, browser, and engine identifiers.

`VIEW.json` has `kind: "bun-wasm-goals-view"` and `resumable: false`. It has no run
schema, campaign source, or campaign deadline policy. Run, resume, and fleet combine
reject it, even if it is renamed to `TABLE.json`. They retain their existing strict
source, deadline, evidence, and current-catalog validation.

## Evidence and selection

Each `inputs` entry records the original absolute path, SHA-256 of its bytes, and
complete parsed schema-2 report. This preserves source and product asset identities,
file inventories, commands, deadline policies, cell discovery, full errors, browser
capabilities, resources, and every original attempt. Relative evidence references
still belong to that original report directory. Keep the original reports and logs.

Visible cells reference their input, original cell index, and attempt index. Indices
are zero-based in JSON. Markdown input labels start at one. `observations` includes
pending and prerequisite observations. `attempts` includes every observed attempt,
including repeated history from different inputs.

The latest actual attempt determines the visible outcome, ordered by recorded finish
time and then start time. Success gets no priority. Equal-time conflicting attempts
are rejected. Identical evidence keeps both references. Duplicate input paths or run
identities, malformed evidence, and invalid timestamps are rejected.

A later pending or unavailable observation cannot replace an actual attempt. Its
blocker stays in the history. A cell without an attempt is `unattempted`, not a result.
The install phase is shown separately. Install PASS never hides an overall failure
in dev, render, click, a later phase, or cleanup.

Archive content validation uses each input's own complete rectangular inventory and
recorded deadlines. Historical schema-2 reports without build overrides keep that
field absent, and their build phases must match the recorded general phase deadline.
Current executable reports still require the current complete build policy. Parked
engines may be omitted from the visible catalog, but their original cells remain in
`inputs`. Schema 1 is not supported or migrated. Preserve it as a historical snapshot.

The command exits nonzero for invalid input or output errors. Valid views containing
failed cells are still written successfully, because this is a summary, not a test run.
