# PIC+atomics libc for relocated process members

The explicit shared-PIC sysroot compiles wasi-libc revision `2e6fb9d8ee0cdf9e431fbcabe8af3115de000a13` with `-fPIC -matomics -mbulk-memory -mmutable-globals`. It retains the released Waffle preopen patch and adds the member growth import. The ordinary sysroot and default build profile stay unchanged.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `patches/wasi-libc/group-grow.patch`, upstream `libc-bottom-half/sources/sbrk.c` | Port | Import `runtime_shm.group_grow` and keep a private break for each relocated libc image. |
| `scripts/build-shared-wasi-libc.sh`, from Waffle `packages/waffle/scripts/build-wasi-libc.sh` | Port | Adapt the pinned builder for PIC and atomics, apply the growth patch, and retain compile commands. |
| `scripts/build-wasi-sysroot.ts`, shared-PIC variant | Host feature | Extend the producer receipt and key with the explicit profile, flags, growth import and local patch and builder hashes. |
| `tests/fixtures/shared-sysroot/member.c`, `scripts/shared-sysroot-proof.ts`, `scripts/test-shared-sysroot.sh` | Host feature | Original libc allocator, relocated image and wait/notify proof. Based on the owner's design prototype, without its libc stand-ins. |

## Upstream and local changes

The wasi-libc archive SHA-256 is `f25ccd526235f7b351f9b49451b75fdd8e23250b9ad8fc9f8f2a19f517a4892f`. The builder derives from Waffle revision `9bc224595a4f8b650fc19b2c18f39c1d484ee090`, builder SHA-256 `85d6a1e6793390fe6c8c36762168f673cfe8fc7ecd5abc6daf27c05d82f7cf0e`. The Waffle preopen patch SHA-256 is `856730a158d7fdaa08a787c572883a57baaf09a4d967b366c9d198a9c98de302`.

`sbrk` uses the host import for positive page increments. All negative host results map to ENOMEM. A private static tracks the end of that image's latest successful chunk. Stock `sbrk(0)` reads the whole memory size, which would expose another member's chunks as allocator space. The local break prevents that race and permits the host to recycle chunks below the high-water mark.

The build sets `MORECORE_CONTIGUOUS=0` to use dlmalloc's existing noncontiguous segment handling. It does not replace dlmalloc or enable the pthread target. The allocator globals and errno remain in each member's relocated data. Core libc ownership and engine imports are unchanged.

The proof instantiates the same PIE image in two concurrent Node workers on one shared memory. Each has separate data, stack and table reservations. Every real malloc block is checked against the calling member's host-owned chunk ledger. Guard pages force noncontiguous growth and expose accidental use of the memory high-water mark. Further checks cover free reuse, private errno and break state, negative growth errors, and shared-region atomic wait/notify.

[Ledger scope and pinned revisions](scope.md).
