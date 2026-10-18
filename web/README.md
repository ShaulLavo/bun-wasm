# Browser playground

The playground provides a terminal, editor and in-memory filesystem for running Bun guests in a browser.

From the repository root:

```sh
bun install --cwd web --frozen-lockfile
(cd web && bun run build)
PORT=0 bun web/serve.ts
```

[Guide and reference](../docs/guides/playground.md).
