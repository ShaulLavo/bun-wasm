import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-spawn-module-types-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const declarations = join(root, "crates/bunwasm-runtime/src/js");

for (const order of [["worker_protocol.d.ts", "bun_shell_types.d.ts"], ["bun_shell_types.d.ts", "worker_protocol.d.ts"]]) {
  test(`spawn module keeps ordinary and private entries with declaration order ${order.join(", ")}`, () => {
    const probe = join(scratch, "probe.ts");
    const config = join(scratch, "tsconfig.json");
    writeFileSync(probe, `declare const internal: BunWasm.Internal;
const module = internal.require("spawn");
const child: BunWasm.WorkerChild = module.spawn(["bun"], {});
const worker: BunWasm.WorkerChild = module.spawnWorker(["bun"], {}, {});
const executable: string | null = module.which("bun");
// @ts-expect-error A primitive is not a private Worker request.
module.spawnWorker(["bun"], {}, 7);
`);
    writeFileSync(config, JSON.stringify({ compilerOptions: {
      target: "ES2022", module: "ESNext", strict: true, skipLibCheck: true, noEmit: true, types: [],
    }, files: [join(declarations, "runtime.d.ts")].concat(order.map(name => join(declarations, name)), [probe]) }));
    const result = Bun.spawnSync([join(root, "web/node_modules/.bin/tsc"), "-p", config]);
    expect(result.stdout.toString() + result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });
}
