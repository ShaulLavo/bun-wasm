import { expect, test } from "bun:test";
import { guestCommand } from "./guest-command.ts";

const request = {
  project: "/work/tmp/project with spaces", args: ["run", "node_modules/vite/bin/vite.js"],
  port: 3137, registry: "http://127.0.0.1:8000",
};

test("guest project and writable locations live below the filesystem root", () => {
  const command = guestCommand({ ...request, host: ["/launcher", "--wasm", "/core.wasm"] });
  expect(command).toContain(`${request.project}::/app`);
  for (const entry of ["PWD=/app", "HOME=/app", "TMPDIR=/app/tmp", "BUN_INSTALL_CACHE_DIR=/app/.cache"]) {
    expect(command).toContain(entry);
  }
});

for (const host of [["/launcher", "--wasm", "/core.wasm"], ["node", "--no-warnings", "/node-host.mjs", "--net", "--wasm", "/browser.wasm"]]) {
  test(`guest workspace keeps the selected ${host[0]} host, artifact, arguments and network settings`, () => {
    const command = guestCommand({ ...request, host });
    expect(command.slice(0, host.length)).toEqual(host);
    expect(command.slice(command.indexOf("--") + 1)).toEqual(request.args);
    expect(command).toContain("PORT=3137");
    expect(command).toContain("PRISMA_ENGINES_MIRROR=http://127.0.0.1:8000/blocked-prisma-engines");
    expect(command).toContain("BUN_WASM_TRACE_EXIT=1");
    expect(command.filter(value => value === "--dir")).toHaveLength(1);
  });
}
