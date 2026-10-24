## OPFS storage adapter

Class **Host feature**, original adapter in `waffle/fs/opfs.ts`, informed by SLICC-kernel
`src/fs/opfs.ts` at commit `88c5bb3` (Apache-2.0). The SLICC implementation's bounded sync-access
handle retry loop for `NotReadableError`/`InvalidStateError` and its `QuotaExceededError` to
`ENOSPC` mapping are adapted here. The layout, snapshot recovery, Web Lock lifetime, lazy payload
reads, browser-specific create concurrency and 64-handle cache are original Waffle behavior;
no SLICC code is copied verbatim.
The pinned Waffle ownership contract queues an occupied Web Lock instead of refusing it.
The original playground UI adapter displays waiting, disables startup controls and continues
automatically in the same document when the owner closes. Browser fixtures observe waiting,
await disposal before reopening and retain acknowledged saved bytes without reload. The
adapted SLICC retry and quota behavior stay unchanged. The measured OPFS corpus and browser
evidence are maintained with Waffle in
[`docs/benchmarks/filesystem-persistence-opfs-2026-10-17.json`](https://github.com/ShaulLavo/waffle/blob/main/docs/benchmarks/filesystem-persistence-opfs-2026-10-17.json).


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`waffle/fs/opfs.ts`, OPFS access-handle and quota adapters](#opfs-storage-adapter) | Host feature | Original one-file-per-payload storage adapter with guidance for occupied workspaces; adapts SLICC-kernel's Apache-2.0 `src/fs/opfs.ts` at 88c5bb3 for NotReadableError retries and QuotaExceededError mapping while retaining bun-wasm's checksummed snapshots, lazy index and bounded cache. |
