# Bun guest artifact publishing

Matching Bun guests are published as immutable, hash-addressed R2 objects and verified before descriptor generation.

```sh
source env.sh
bun install --cwd site --frozen-lockfile
```

With the matching full builds and existing Cloudflare credentials configured:

```sh
bun scripts/publish-guest.ts /path/to/bun.wasm --output src/guest-asset.generated.ts
```

[Publishing and cleanup](../docs/guest-publishing.md) · [Required browser acceptance](../docs/browser-package.md#required-full-build-interruption-acceptance)
