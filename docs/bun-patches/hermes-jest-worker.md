# Hermes Next worker require lookup

## Classification

| Source | Class | Origin and change |
| --- | --- | --- |
| `tests/hermes/fixtures/next-jest-worker/{processChild,threadChild}.js` | Upstream test inputs | Unchanged files from Next 16.4.3, `dist/compiled/jest-worker/`. The npm tarball SHA-256 is `d37409b7530c4873cd14c0619a7b8734777fd0dc2cae627bb592e5a82f74f8f4`. The bundled MIT license is retained beside them. |
| `tests/hermes/jest-worker-require.cts` | Original test adapter | Exercises the real process worker's message listener and teardown. A conflicting working-directory module checks that its require remains relative to the worker module. |

The current Hermes Next build reaches `execMethod` in `processChild.js` and fails
at `eval("require")(file)`. Hermes evaluates that string in global scope. The
CommonJS wrapper's require is lexical, so the lookup raises a ReferenceError.
The fixture also checks that no global require is installed.
