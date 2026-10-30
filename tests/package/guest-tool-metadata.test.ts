import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hash } from "../../scripts/guest-source-manifest.ts";
import { receiptCli, withCliReceiptFixture } from "./guest-receipt-fixture.ts";

const linker = `#!/bin/sh
if [ "\${LLD_REPRODUCE+x}" = x ]; then
  printf '%s\\n' "$@" > "$LLD_REPRODUCE"
fi
printf '%s\\n' "$@" > "$0.args"
printf '%s\\n' "$GUEST_METADATA_MARKER" > "$0.env"
printf 'fixture rust-lld 1\\n'
`;

const probe = `import { captureSourceManifest, run, sourceOptions } from "../scripts/guest-source-manifest.ts";
const [sysroot, linker] = process.argv.slice(2);
const reproduce = process.env.LLD_REPRODUCE;
const marker = process.env.GUEST_METADATA_MARKER;
if (!sysroot || !linker || !reproduce) throw new Error("Missing fixture inputs");
const manifest = await captureSourceManifest(sourceOptions(process.cwd(), sysroot, "browser"));
if (process.env.LLD_REPRODUCE !== reproduce || process.env.GUEST_METADATA_MARKER !== marker) throw new Error("Metadata changed caller environment");
const afterMetadata = await Bun.file(reproduce).text();
const metadataArgs = await Bun.file(linker + ".args").text();
const metadataMarker = await Bun.file(linker + ".env").text();
run([linker, "--fixture-link", "input.o", "-o", "output.wasm"], process.cwd());
console.log(JSON.stringify({ tool: manifest.tools.find(tool => tool.name === "rust-lld"), afterMetadata, metadataArgs, metadataMarker, afterLink: await Bun.file(reproduce).text() }));
`;

test("tool metadata preserves the linker reproducer and caller environment while link commands retain it", async () => {
  await withCliReceiptFixture(async fixture => {
    const reproduce = join(fixture.root, "private/core-link.tar");
    const runner = join(fixture.root, "private/metadata-probe.ts");
    await writeFile(reproduce, "original core archive marker\n");
    await writeFile(fixture.linker, linker);
    await writeFile(runner, probe);
    const env = { ...fixture.env, LLD_REPRODUCE: reproduce, GUEST_METADATA_MARKER: "keep unrelated environment" };
    const result = Bun.spawnSync([process.execPath, runner, join(fixture.root, "sysroot"), fixture.linker], { cwd: fixture.root, env });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      tool: { name: "rust-lld", path: fixture.linker, sha256: hash(await readFile(fixture.linker)), version: "fixture rust-lld 1" },
      afterMetadata: "original core archive marker\n",
      metadataArgs: "-flavor\nwasm\n--version\n",
      metadataMarker: "keep unrelated environment\n",
      afterLink: "--fixture-link\ninput.o\n-o\noutput.wasm\n",
    });
    expect(env.LLD_REPRODUCE).toBe(reproduce);
    expect(await readFile(reproduce, "utf8")).toBe("--fixture-link\ninput.o\n-o\noutput.wasm\n");
  });
});

test("failed tool metadata remains a failure without overwriting the linker reproducer", async () => {
  await withCliReceiptFixture(async fixture => {
    const reproduce = join(fixture.root, "private/core-link.tar");
    await writeFile(reproduce, "original core archive marker\n");
    await writeFile(fixture.linker, linker + "printf 'fixture version failed\\n' >&2\nexit 37\n");
    fixture.env.LLD_REPRODUCE = reproduce;
    const result = receiptCli(fixture, "inputs", "browser");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Guest source check failed: fixture version failed");
    expect(await readFile(reproduce, "utf8")).toBe("original core archive marker\n");
    expect(fixture.env.LLD_REPRODUCE).toBe(reproduce);
    expect(await Bun.file(`${fixture.artifact}.build.json`).exists()).toBe(false);
  });
});
