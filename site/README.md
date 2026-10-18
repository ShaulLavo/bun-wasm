# Public site and guest artifacts

The public demo combines the sandbox and playground, with immutable wasm guests published separately.

From the repository root:

```sh
source env.sh
cd site
bun install
bun run build
```

[Guest publication, Cloudflare resources, and verification](../docs/guest-publishing.md).
