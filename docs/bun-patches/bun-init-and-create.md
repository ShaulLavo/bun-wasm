# bun init and bun create

| Local source | Classification | Upstream source |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/init.rs`: flags, package name, entry point inference, package.json fields, files written, messages | Adapted upstream implementation | Bun `src/runtime/cli/init_command.rs` at `9510e74152073d850a18758ca41114d8f214ffa6`, SHA-256 `895d467493525ee1170d1fe40466bf7e58f43b124cb6a7af8bc2ff2c4a0abc5c` |
| `.gitignore`, `tsconfig.json`, `README.md` contents | Upstream files, included from `vendor/bun` at build time | `src/runtime/cli/init/gitignore.default` (`c9966ff0…`), `tsconfig.default.json` (`4dc04b19…`), `README.default.md` (`4a9979f4…`) at the same revision |
| `bun init` help text | Adapted upstream text | Bun `src/runtime/cli/mod.rs` `Tag::InitCommand` help, SHA-256 `e40ef30e79727d595e20aae4b305baf073f7acaeaf7cdf08f862ef7837263cd7` |
| `crates/bunwasm-cli/src/main.rs` `create_command` and `create_package` | Adapted upstream implementation | Bun `src/runtime/cli/mod.rs` `bun_create` and `src/runtime/cli/bunx_command.rs` `add_create_prefix` (SHA-256 `c9b4948782b3178835b94167a7092dd3afa347b88fc242390ed0938a5d89634e`) |

`bun init` writes the blank template the same way Bun does: `package.json` with `name`, `module`, `type`, `private`, a `typecheck` script for TypeScript entries, `@types/bun` and the `typescript` peer, then `.gitignore`, the entry file, `tsconfig.json` (or `jsconfig.json`) and `README.md`, skipping files that exist. It then runs the install in-process instead of spawning `bun install`. `-m` writes only the minimal files. Differences: there is no terminal template picker, so every run takes the default Blank template as `-y` does; `--react` templates exit with an error; Bun's agent rule files (`CLAUDE.md`, Cursor rules) are not written because their detection looks for native `claude` and Cursor installs.

`bun create <template>` runs `bun x create-<template>` with the remaining arguments, using Bun's name rules (`@scope/name` becomes `@scope/create-name`, `@scope` becomes `@scope/create`). GitHub repositories, local `.bun-create` templates and React component files are not supported and exit with an error, as do Bun's retired `react` and `next` names.

The browser proof is the `bun-init` and `bun-create` stages of `web/tests/browser-shell-product.ts` (`bun create vite` with `create-vite` 9.3.3).
