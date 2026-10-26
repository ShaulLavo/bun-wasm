import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const root = resolve(import.meta.dir, "..");
const runtime = join(root, "crates/bunwasm-runtime/src/js");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-package-port-typed-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const source = readFileSync(join(runtime, "net_port.ts"), "utf8");

function check(probe: string) {
  const input = join(scratch, "probe.ts");
  const config = join(scratch, "tsconfig.json");
  writeFileSync(input, `declare const internal: BunWasm.Internal;\nconst factory = ${source};\n${probe}`);
  writeFileSync(config, JSON.stringify({
    extends: join(root, "crates/bunwasm-runtime/tsconfig.json"), include: [],
    files: ["runtime.d.ts", "websocket_types.d.ts", "net_port_types.d.ts"].map(file => join(runtime, file)).concat([input]),
  }));
  return Bun.spawnSync([join(root, "web/node_modules/.bin/tsc"), "-p", config], { stdout: "pipe", stderr: "pipe" });
}

test("Node's actual runtime stripper emits the typed validator as a strict factory", () => {
  const output = join(scratch, "net_port.js");
  const emitted = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), join(runtime, "net_port.ts"), output], { stdout: "pipe", stderr: "pipe" });
  expect(emitted.exitCode, emitted.stderr.toString()).toBe(0);
  const text = readFileSync(output, "utf8");
  expect(text.split("\n").length).toBe(source.split("\n").length);
  expect(text).toContain('"use strict";');
  const ports = runInNewContext(text)();
  const address = runInNewContext(readFileSync(join(runtime, "net_address.js"), "utf8"))({ require: () => ports });
  expect(address.port).toBe(ports.port);
  expect(address.error).toBe(ports.error);
  expect(ports.httpPort("0")).toBe(0);
  expect(ports.port("3137")).toBe(3137);
  expect(() => ports.httpPort(NaN)).toThrow(expect.objectContaining({ code: "ERR_SOCKET_BAD_PORT" }));
  expect(() => ports.httpPort({})).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }));
});

test("the runtime source set registers one implementation and excludes its declaration file", () => {
  const names = readdirSync(runtime).filter(file => file.endsWith(".js") || (file.endsWith(".ts") && !file.endsWith(".d.ts")));
  expect(names.filter(file => file.replace(/\.(?:js|ts)$/, "") === "net_port")).toEqual(["net_port.ts"]);
  expect(names).not.toContain("net_port_types.d.ts");
});

test("actual factory, helper declaration, and net_address exports have compatible signatures", () => {
  const result = check(`
    const actual = factory();
    const declared = internal.require("net_port");
    const fromActual: typeof declared = actual;
    const fromDeclared: typeof actual = declared;
    const address = internal.require("net_address");
    const sharedPort: typeof actual.port = address.port;
    const sharedError: typeof actual.error = address.error;
    const numeric: number = fromActual.port({});
    const http: number = fromDeclared.httpPort(undefined);
    const range: RangeError & {code: string} = sharedError(RangeError, "ERR_SOCKET_BAD_PORT", "invalid");
    const normalized: number = sharedPort("0");
  `);
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
});

const invalid = [
  'internal.require("net_address").error("RangeError", "ERR_SOCKET_BAD_PORT", "invalid");',
  'internal.require("net_address").error(RangeError, 1, "invalid");',
  'internal.require("net_port").error(RangeError, "ERR_SOCKET_BAD_PORT", 1);',
  'const wrong: string = internal.require("net_address").port("0");',
  'const wrong: string = internal.require("net_port").httpPort(0);',
  'internal.require("net_ports");',
];
for (const probe of invalid) test(`rejects an invalid typed port contract: ${probe}`, () => {
  const result = check(probe);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).toContain("error TS");
});
