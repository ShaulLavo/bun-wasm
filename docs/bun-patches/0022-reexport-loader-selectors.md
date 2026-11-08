# Direct re-export loader selectors

Classification: upstream bug fix.

Upstream: oven-sh/bun at `9510e74152073d850a18758ca41114d8f214ffa6`,
`src/js_parser/parse/parse_stmt.rs`.

Patch: `0022-Preserve-parsed-loader-selectors-on-direct-re-export.patch`.

Bun's path parser already selects a loader for static import attributes. Import
declarations copy that loader to their import record, but direct named and star
re-exports did not. Copy the parsed loader in those two branches so runtime text
request lowering sees the same semantic metadata for all static requests.

This patch adds no attribute grammar, dynamic-import transform or printer behavior.
Compiler controls cover direct named and namespace re-exports alongside imports.
