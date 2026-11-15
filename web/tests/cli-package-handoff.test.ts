import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const text = (value: string) => [value.length].concat(Array.from(new TextEncoder().encode(value)));
const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);

/** Real CLI input: call handoff with invalid spans and trap unless the host returns NOTSUP. */
function unsupportedGuest(): Uint8Array {
  const body = [0].concat([0x41, 0x7f], [0x41, 0x7f], [0x41, 0x7f], [0x41, 0x7f],
    [0x10, 0, 0x41, 0x46, 0x47, 0x04, 0x40, 0, 0x0b, 0x0b]);
  return Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, [2, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 0]),
    section(2, [1].concat(text("bun_package_scripts"), text("handoff"), [0, 0])),
    section(3, [1, 1]), section(5, [1, 0, 1]),
    section(7, [2].concat(text("memory"), [2, 0], text("_start"), [0, 1])),
    section(10, [1, body.length].concat(body)),
  ));
}

test("the actual CLI shim links the package import and returns NOTSUP before pointer access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-cli-handoff-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const path = join(directory, "handoff.wasm");
    await writeFile(path, unsupportedGuest());
    const running = Bun.spawn([process.execPath, new URL("../scripts/run.ts", import.meta.url).pathname, path], {
      env: { ...process.env, NET: "0" }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000,
    });
    child = running;
    const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally {
    child?.kill();
    await child?.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
