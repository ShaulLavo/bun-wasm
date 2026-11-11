# Explicit program memory profile delivery

Status: Approved. Implementation is ready for the Engines parent's independent review.

The playground, sandbox and maintained goals runner select `split` or `shared-group`
independently of the engine. Split remains the default. Shared QuickJS and JSC assets
live under `profiles/shared-group/`, with matching cores and sides and unchanged
original receipts. Both pages use the authoritative Bun memory group policy.

Ordinary SpiderMonkey preparation from PR 602 is preserved. Shared SpiderMonkey and
Browser selection fail as unavailable in this host revision. Capacity, the Waffle pin,
JSC getters and framework acceptance remain with their existing owners.

The production browser check covers ordinary SAB traffic, Memory/Module worker identity,
Bun subprocess groups, owner settlement, split refusal, mismatched assets and poisoned
caches. Goals preparation verifies the current shell receipt independently of the Bun
guest source, preserves component labels and checks a closed prepared-site inventory.

Verification, the exact asset contract and cleanup evidence are retained in
`/work/reports/goals/engines/shared-wasm-memory/explicit-profile-delivery-20261111/`.
