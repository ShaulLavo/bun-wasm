import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("a failed initial navigation reports its step and error", async () => {
  const server = createServer(socket => socket.destroy());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const child = Bun.spawn(["node", "sandbox/tests/hmr-check.mjs", `http://127.0.0.1:${address.port}/`, "--engines", "browser", "--browsers", "chromium"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1);
    expect(stdout).toContain("1 of 1 runs failed");
    expect(stdout).toContain("FAIL chromium/browser 0 navigation:");
    expect(stdout.concat(stderr)).toContain("ERR_EMPTY_RESPONSE");
  } finally {
    child.kill();
    await child.exited;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 30_000);
