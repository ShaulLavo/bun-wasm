# CI cache retention

Status: Approved.

On November 10, 2026, the main JSC prebuild saved at 10:07 UTC was absent at
12:31 UTC. Main recreated it at 13:04 UTC and a PR restored it at 13:05 UTC.
The cache inventory held 10,961,105,675 bytes across 34 entries. PR-only entries
held 4,369,222,457 bytes. Rust object snapshots reached 1.2 GB each.

This lane stops PR cache writes while preserving restores, then bounds main's
Rust object snapshots without adding a repository-wide deletion workflow.
Targeted policy tests cover workflows, composite actions, and main versus PR
conditions. No cache deletion or native rebuild belongs to this change.
