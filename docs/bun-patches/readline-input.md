# Readline input without waiting for EOF

| Local source | Classification | Reference |
| --- | --- | --- |
| `src/js/node_readline.ts` and the `node:readline` registry entry in `src/js/builtins.js` | Original adapter | Node `readline.createInterface` and input-stream behavior. The previous local implementation is `builtins.js` at `d505fb24ed73215043266484040b65fa0e857176`. No upstream implementation is copied. |
| `scripts/readline-input.test.ts`, `tests/fixtures/readline-open-input`, `tests/fixtures/readline-async-iterator`, and `tests/hermes/hello.cts` | Original tests | Open-pipe line delivery, questions, iteration, listener cleanup, and an HTTP response before stdin EOF. The Hermes smoke runs the discovered iteration verifier before printing its existing hello result. |

The old adapter treated `process.stdin` differently from other streams. Adding a
line listener scheduled a synchronous `native.readStdin()` call, which reads until
EOF. Vite 7.1.12 installs this listener for its terminal shortcuts after announcing
its HTTP listener. An open terminal therefore stopped the guest before it accepted
a connection. The same read also blocked questions and async iteration.

The TypeScript adapter consumes data and end events for every supplied input,
including `process.stdin`. Questions use the next delivered line. Async iteration
uses the same line events. Closing an interface removes its input listeners and
pauses the reader without destroying the shared stdin descriptor. A scheduled
startup checks whether the interface has already closed before attaching listeners.

The native fixture keeps its child stdin pipe open while requesting an HTTP page,
waiting for a timer, and receiving a line. EOF is sent only after those assertions.
The source tests run the actual builtin registry and adapter with a stream input.
Their passing result is not compiled-guest or Vite application acceptance.

The nested `nextLine` helper is an async function declaration. The immutable Hermes
guest rejects an async arrow inside an async generator with `'yield' not in a
generator function`, even when the arrow contains only `await`. An equivalent
function declaration parses and keeps the same captured line queue and wakeup.
The ordinary runtime emitter erases types without rewriting either syntax.
Source tests use that exact emitter rather than Bun's printer. The discovered
native iteration fixture also runs through the existing blocking Hermes hello
smoke, using the already-built core and side without a second compilation.

[Ledger scope and pinned revisions](scope.md).
