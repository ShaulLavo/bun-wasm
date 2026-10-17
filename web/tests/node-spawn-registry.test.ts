import { expect, test } from "bun:test";
import { SubprocessHost, childTransport, type ChildTransport } from "../src/subprocess.ts";
import { launchNodeExecutable } from "../scripts/node-spawn.ts";

for (const executable of ["bun", "/bun", "/usr/local/bin/bun", "node", "/node", "/usr/local/bin/node"]) test(`Node host registry explicitly resolves ${executable}`, () => {
  let launched = 0;
  const host = new SubprocessHost({ output() {}, launch(meta, transport) {
    return launchNodeExecutable(meta, transport, () => { launched++; childTransport(transport).started(); return { terminate() {} }; });
  } });
  try {
    const pid = host.spawn(JSON.stringify({ argv: [executable, "argument"] }));
    expect(pid).toBeGreaterThan(1);
    expect(launched).toBe(1);
    expect(host.wait(pid)).toBe(-2);
  } finally { host.dispose(); }
});

test("Node host does not silently execute Bun for a missing registry entry", () => {
  let launched = 0;
  let child: ChildTransport | undefined;
  const host = new SubprocessHost({ output() {}, launch(meta, transport) {
    child = transport;
    return launchNodeExecutable(meta, transport, () => { launched++; childTransport(transport).started(); return { terminate() {} }; });
  } });
  try {
    const pid = host.spawn(JSON.stringify({ executable: "missing", argv: ["missing"] }));
    expect(pid).toBe(-1);
    expect(launched).toBe(0);
    expect(child?.pid).toBeGreaterThan(1);
    expect(JSON.parse(host.lastError!)).toMatchObject({ code: "ENOENT", errno: -2, path: "missing" });
    expect(host.children.size).toBe(0);
    expect(host.handles.size).toBe(0);
  } finally { host.dispose(); }
});
