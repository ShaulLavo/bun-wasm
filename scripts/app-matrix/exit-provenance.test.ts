import { expect, test } from "bun:test";
import { firstError } from "./classify.mjs";

test("system errors in framework logs retain their diagnostic", () => {
  expect(firstError('1 | import.meta.require("ws")\nENOENT: no such file or directory, open \'ws\'\n    at /vite/config.js:23728:63')).toBe("ENOENT: no such file or directory, open 'ws'");
});

import { exitProvenance } from "./exit-provenance.ts";

test("exit provenance keeps host signals separate from guest exits", () => {
  const record = { reason: "process.exit", code: 7, stack: "at cli.ts:1:1", loop: { refedTimers: 0 } };
  expect(exitProvenance({ code: null, signal: "SIGKILL", timedOut: true, output: '[bun-wasm:exit] ' + JSON.stringify(record) + '\n[bun-wasm:exit] {' })).toEqual({ exit: null, signal: "SIGKILL", timedOut: true, runtimeExits: [record] });
  expect(exitProvenance({ code: 0, output: '[bun-wasm:exit] {"code":"wrong"}' }).runtimeExits).toEqual([]);
});

test("a quiet exit still has a classified reason", () => {
  expect(firstError('[bun-wasm:exit] {"reason":"event-loop-drained","code":0,"stack":null,"loop":{"refedTimers":0}}')).toBe("Runtime exited 0: event-loop-drained");
});

test("Astro's message-only module error keeps the missing export", () => {
  const message = "The requested module 'bunwasm:/m/node%3Ahttp2' does not provide an export named 'Http2ServerResponse'";
  expect(firstError(message + '\n[bun-wasm:exit] {"reason":"process.exit","code":1,"stack":null,"loop":null}')).toBe(message);
});

test("SvelteKit's timestamped Vite SSR diagnostic stays visible", () => {
  const message = 'Error when evaluating SSR module /node_modules/@sveltejs/kit/src/runtime/server/index.js: transport was disconnected, cannot call "fetchModule"';
  expect(firstError('6:37:22 AM [vite] (ssr) ' + message)).toBe(message);
});

for (const message of [
  "circular import: binding 'Fragment' is not resolvable in module '/node_modules/astro/dist/runtime/server/index.js'",
  "Export named 'Http2ServerResponse' not found in module 'node:http2'.",
]) {
  test(`Astro retains the engine message ${message}`, () => {
    expect(firstError(message + '\n[bun-wasm:exit] {"reason":"process.exit","code":1,"stack":null,"loop":null}')).toBe(message);
  });
}
