# Bun demo and guest publishing

The public demo combines the playground and sandbox and uses immutable, verified Bun guest artifacts.

From the repository root:

```sh
bun install --cwd site --frozen-lockfile
(cd site && bun run build)
ROOT=site/dist PORT=0 bun web/serve.ts
```

[Guide and reference](../docs/guides/publishing.md).
