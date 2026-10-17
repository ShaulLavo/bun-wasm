import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { firstError } from "./classify.mjs";

test("system errors in framework logs retain their diagnostic", () => {
  expect(firstError('1 | import.meta.require("ws")\nENOENT: no such file or directory, open \'ws\'\n    at /vite/config.js:23728:63')).toBe("ENOENT: no such file or directory, open 'ws'");
});

import { exitProvenance } from "./exit-provenance.ts";

function runtimeExitFixture(settings: { writeFails?: boolean; loopFails?: boolean; output?: string; enabled?: boolean } = {}) {
  let output = settings.output ?? "";
  const exits: number[] = [];
  const internal = {
    native: {
      platformInfo: {},
      env: () => ({ BUN_WASM_TRACE_EXIT: settings.enabled === false ? "0" : "1" }),
      argv: () => [],
      hostSignal: () => 0,
      writeStderr(text: string) {
        if (settings.writeFails) throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
        output += text;
      },
      exit(code: number): never {
        exits.push(code);
        throw new Error(`guest exit ${code}`);
      },
    },
    emitExit() {},
    loopState() {
      if (settings.loopFails) throw new Error("loop diagnostics failed");
      return { refedTimers: 0 };
    },
    require(name: string) {
      if (name === "events") return EventEmitter;
      const extension = name === "process" ? "js" : "ts";
      const source = readFileSync(new URL(`../../crates/bunwasm-runtime/src/js/${name}.${extension}`, import.meta.url), "utf8");
      const factory = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${source}`));
      return factory(internal);
    },
  };
  internal.require("exit_provenance");
  return { process: internal.require("process"), exits, output: () => output };
}

for (const [method, code] of [["exit", 7], ["reallyExit", 6], ["abort", 134]] as const) {
  for (const failure of ["writeFails", "loopFails"] as const) {
    test(`process.${method} still exits when exit tracing encounters ${failure}`, () => {
      const fixture = runtimeExitFixture({ [failure]: true });
      expect(() => fixture.process[method](code)).toThrow(`guest exit ${code}`);
      expect(fixture.exits).toEqual([code]);
    });
  }
}

test("runtime exit tracing starts a record after a partial stderr line", () => {
  const fixture = runtimeExitFixture({ output: "progress" });
  expect(() => fixture.process.exit(7)).toThrow("guest exit 7");
  expect(fixture.output()).toStartWith("progress\n[bun-wasm:exit] ");
  expect(exitProvenance({ code: 7, output: fixture.output() }).runtimeExits).toEqual([
    { reason: "process.exit", code: 7, stack: expect.any(String), loop: { refedTimers: 0 } },
  ]);
});

test("disabled exit tracing does not write or collect diagnostics", () => {
  const fixture = runtimeExitFixture({ enabled: false, loopFails: true });
  expect(() => fixture.process.exit(7)).toThrow("guest exit 7");
  expect(fixture.exits).toEqual([7]);
  expect(fixture.output()).toBe("");
});

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
