# Diagnostic source records

## Copied test helper

Classification: test-only copied implementation, not a public export or a production runtime change.

Upstream: `ShaulLavo/waffle`, revision `5cf130c45621c676e593b0e31092baa640ea5e46`, `packages/waffle/tests/fixtures/filesystem-endpoint-observer.ts`. Original SHA-256: `fdfaabfd613cc874d57c8180960b940f6c48c9a45c7b8d178daf92ca1b45fd70`.

Local file: `upstream-observer.ts`. Only its two private filesystem import prefixes change. They resolve against the exact selected Sandbox installation. Its filesystem/helper algorithms remain unchanged. This record lives with the diagnostic because this task explicitly limits edits to its isolated workflow and diagnostic directory.

## Original adapters

Classification: original diagnostic adapters derived from Storage's retained `browser-sandbox-entry/current84` prototype.

`endpoint.ts`, `post.ts`, `endpoint-identity.ts`, `qualify.ts`, `controls.ts`, `transforms.ts`, and their source controls retain the original consumer entry seams and qualification outcomes. Their new transport uses per-Worker MessagePorts and an exact original runtime reference instead of a global BroadcastChannel. The executor adapter only observes and forwards original hooks. Fixed labelled controls remain optional and are absent from the full scenario.

`instrument-build.ts` intercepts the original subject's Sandbox main/model, Bun entry, Browser-host checkpoint, filesystem service prelude, and installed Bash entry. `BUILD-INTERCEPTION.json` records the original and transformed hashes and complete executed bodies. It changes no original filesystem or helper algorithm. `capture.ts` calls the original scenario and normal static server. The remaining files own source admission, retained bytes, process supervision, and cleanup.
