# Explicit program memory profile delivery

Status: Approved. Implementation claim for the Engines lane.

The playground, sandbox and maintained goals runner select `split` or `shared-group`
explicitly, independently of the engine. Split remains the default. Shared assets
live under `profiles/shared-group/`, with matching core and side modules and their
original receipts. The runtime uses the authoritative Bun memory group policy.

Verification and cleanup evidence is retained in
`/work/reports/goals/engines/shared-wasm-memory/explicit-profile-delivery-20261111/`.
