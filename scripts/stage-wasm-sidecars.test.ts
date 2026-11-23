import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { replaceFiles, writeWasmWithSidecars } from "./stage-wasm-sidecars";
import { writeShellGuests } from "./browser-build";

test("program staging writes the raw WASM with smaller Brotli and gzip twins of the same bytes", async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bw-sidecars-"));
  try {
    const bytes = new Uint8Array(256 * 1024);
    bytes.set([0, 97, 115, 109, 1, 0, 0, 0]);
    for (let index = 8; index < bytes.length; index++) bytes[index] = (index * 31) % 7;
    const path = join(directory, "programs/shell-engine.wasm");
    await writeWasmWithSidecars(path, bytes);
    const raw = await Bun.file(path).bytes();
    const br = await Bun.file(`${path}.br`).bytes();
    const gz = await Bun.file(`${path}.gz`).bytes();
    expect(raw).toEqual(bytes);
    expect(new Uint8Array(brotliDecompressSync(br))).toEqual(bytes);
    expect(new Uint8Array(gunzipSync(gz))).toEqual(bytes);
    expect(br.length).toBeLessThan(gz.length);
    expect(gz.length).toBeLessThan(bytes.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed twin write keeps the earlier raw and gzip files and leaves no temporary files", async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bw-sidecars-"));
  try {
    const path = join(directory, "env.wasm");
    await Bun.write(path, "earlier raw");
    await Bun.write(`${path}.gz`, "earlier gzip");
    const failing = async (target: string, bytes: Uint8Array) => {
      if (target.startsWith(`${path}.br.`)) throw new Error("disk full");
      await writeFile(target, bytes);
    };
    await expect(writeWasmWithSidecars(path, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), failing)).rejects.toThrow("disk full");
    expect(await Bun.file(path).text()).toBe("earlier raw");
    expect(await Bun.file(`${path}.gz`).text()).toBe("earlier gzip");
    expect((await readdir(directory)).sort()).toEqual(["env.wasm", "env.wasm.gz"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A rename that fails when it would place the new Brotli file, after the gzip file already moved in. */
function failingSecondRename(path: string) {
  return async (from: string, to: string) => {
    if (to === `${path}.br` && from.endsWith(".tmp")) throw new Error("rename failed");
    await rename(from, to);
  };
}

test("a failed second rename on a clean build leaves no lone first file", async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bw-sidecars-"));
  try {
    const path = join(directory, "bun.wasm");
    const outputs: [string, Uint8Array][] = [[`${path}.gz`, new TextEncoder().encode("new gzip")], [`${path}.br`, new TextEncoder().encode("new br")]];
    await expect(replaceFiles(outputs, writeFile, failingSecondRename(path))).rejects.toThrow("rename failed");
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed second rename over an existing pair restores the whole previous pair", async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bw-sidecars-"));
  try {
    const path = join(directory, "bun.wasm");
    await Bun.write(`${path}.gz`, "old gzip");
    await Bun.write(`${path}.br`, "old br");
    const outputs: [string, Uint8Array][] = [[`${path}.gz`, new TextEncoder().encode("new gzip")], [`${path}.br`, new TextEncoder().encode("new br")]];
    await expect(replaceFiles(outputs, writeFile, failingSecondRename(path))).rejects.toThrow("rename failed");
    expect(await Bun.file(`${path}.gz`).text()).toBe("old gzip");
    expect(await Bun.file(`${path}.br`).text()).toBe("old br");
    expect((await readdir(directory)).sort()).toEqual(["bun.wasm.br", "bun.wasm.gz"]);
    // A later attempt that succeeds replaces both and keeps no backups.
    await replaceFiles(outputs);
    expect(await Bun.file(`${path}.gz`).text()).toBe("new gzip");
    expect(await Bun.file(`${path}.br`).text()).toBe("new br");
    expect((await readdir(directory)).sort()).toEqual(["bun.wasm.br", "bun.wasm.gz"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed shell guest is reported only after the sibling guest finished writing", async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bw-sidecars-"));
  try {
    const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    await Bun.write(join(directory, "shell.wasm"), wasm);
    await Bun.write(join(directory, "env.wasm"), wasm);
    let shellWrites = 0;
    const write = async (target: string, bytes: Uint8Array) => {
      if (target.includes("/programs/env.wasm")) throw new Error("env write failed");
      await Bun.sleep(50);
      await writeFile(target, bytes);
      shellWrites++;
    };
    const guests = [{ program: "shell-engine.wasm", path: join(directory, "shell.wasm") }, { program: "env.wasm", path: join(directory, "env.wasm") }];
    await expect(writeShellGuests(guests, join(directory, "out"), write)).rejects.toThrow("env write failed");
    expect(shellWrites).toBe(3);
    expect((await readdir(join(directory, "out/programs"))).sort()).toEqual(["shell-engine.wasm", "shell-engine.wasm.br", "shell-engine.wasm.gz"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleanup waits for slower writes, so none recreates a temporary file after a failure", async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bw-sidecars-"));
  try {
    const path = join(directory, "env.wasm");
    const failing = async (target: string, bytes: Uint8Array) => {
      if (target.startsWith(`${path}.br.`)) throw new Error("disk full");
      await Bun.sleep(50);
      await writeFile(target, bytes);
    };
    await expect(writeWasmWithSidecars(path, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), failing)).rejects.toThrow("disk full");
    // A write still in flight at rejection would land within its 50 ms delay; give it longer than that.
    await Bun.sleep(150);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a writer that throws synchronously still waits for the earlier writes before cleanup", async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bw-sidecars-"));
  try {
    const path = join(directory, "env.wasm");
    // Outputs are written raw, .gz, .br: the third write throws before returning a promise.
    const failing = (target: string, bytes: Uint8Array): Promise<void> => {
      if (target.startsWith(`${path}.br.`)) throw new Error("sync failure");
      return Bun.sleep(50).then(() => writeFile(target, bytes));
    };
    await expect(writeWasmWithSidecars(path, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), failing)).rejects.toThrow("sync failure");
    // A write still in flight at rejection would land within its 50 ms delay; give it longer than that.
    await Bun.sleep(150);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a directory in a target's place is refused before any file is replaced", async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bw-sidecars-"));
  try {
    const path = join(directory, "env.wasm");
    await Bun.write(path, "earlier raw");
    await mkdir(`${path}.br`);
    await expect(writeWasmWithSidecars(path, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))).rejects.toMatchObject({ code: "EISDIR" });
    expect(await Bun.file(path).text()).toBe("earlier raw");
    expect((await readdir(directory)).sort()).toEqual(["env.wasm", "env.wasm.br"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
