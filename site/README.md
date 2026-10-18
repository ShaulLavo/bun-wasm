# Public demo and guest artifacts

The site hosts the Bun WebAssembly demo and publishes matching guests as immutable artifacts.

Build the guest artifacts first, then run from the repository root:

```sh
cd site
bun install --frozen-lockfile
bun run build
```

[Deployment, artifact publishing, storage resources and verification](../docs/site.md).
