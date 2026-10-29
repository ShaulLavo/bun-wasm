import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const producer = new URL("./build-wasi-sysroot.ts", import.meta.url).pathname;

test("shared receipts and input keys cannot cross the default profile", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-sysroot-inputs-"));
  try {
    const bin = join(scratch, "sdk/bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["clang", "llvm-ar", "llvm-nm", "llvm-ranlib", "cmake", "ninja"]) {
      writeFileSync(join(bin, name), '#!/bin/sh\nprintf "%s\\n" "fixture-tool-1"\n', { mode: 0o755 });
    }
    writeFileSync(join(scratch, "sdk/VERSION"), "fixture-sdk-1\n");
    mkdirSync(join(scratch, "waffle/scripts"), { recursive: true });
    mkdirSync(join(scratch, "waffle/patches/wasi-libc"), { recursive: true });
    writeFileSync(join(scratch, "waffle/scripts/build-wasi-libc.sh"), "must not execute\n");
    writeFileSync(join(scratch, "waffle/patches/wasi-libc/preopen-scan.patch"), "fixture-preopen\n");
    const result = Bun.spawnSync([process.execPath, "-e", `
      import assert from "node:assert/strict";
      import {mkdir, symlink} from "node:fs/promises";
      import {join} from "node:path";
      import {wasiSysrootInputs, buildWasiSysroot} from ${JSON.stringify(producer)};
      const root=${JSON.stringify(scratch)};
      const sdk=join(root,"sdk"), waffle=join(root,"waffle"), output=join(root,"output");
      const overlays=["include/c++","include/wasm32-wasip1/noeh","lib/wasm32-wasip1/noeh"];
      for(const path of overlays) {
        const source=join(sdk,"share/wasi-sysroot",path);
        await mkdir(source,{recursive:true});
        await mkdir(join(output,path,".."),{recursive:true});
        await symlink(source,join(output,path));
      }
      await mkdir(join(output,"lib/wasm32-wasip1"),{recursive:true});
      await Bun.write(join(output,"lib/wasm32-wasip1/libc.a"),"fixture libc");
      const defaults=await wasiSysrootInputs({waffle,sdk});
      const shared=await wasiSysrootInputs({waffle,sdk,profile:"shared-pic"});
      const {profile,sharedBuilderSha256,groupGrowPatchSha256,flags,growthImport,...common}=shared;
      assert.deepEqual(common,defaults);
      assert.equal(profile,"shared-pic");
      assert.equal(growthImport,"runtime_shm.group_grow");
      assert.match(flags,/-fPIC -matomics -mbulk-memory -mmutable-globals/);
      assert.match(sharedBuilderSha256,/^[0-9a-f]{64}$/);
      assert.match(groupGrowPatchSha256,/^[0-9a-f]{64}$/);
      const key=value=>new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
      assert.notEqual(key(shared),key(defaults));
      assert.equal("profile" in defaults,false);
      assert.equal("growthImport" in defaults,false);
      const libcSha256=new Bun.CryptoHasher("sha256").update(await Bun.file(join(output,"lib/wasm32-wasip1/libc.a")).bytes()).digest("hex");
      const save=inputs=>Bun.write(join(output,"bun-wasm-sysroot.json"),JSON.stringify({...inputs,libcSha256}));
      await save(shared);
      await buildWasiSysroot({waffle,sdk,output,profile:"shared-pic"});
      await assert.rejects(buildWasiSysroot({waffle,sdk,output}),/Sysroot inputs changed/);
      await save(defaults);
      await buildWasiSysroot({waffle,sdk,output});
      await assert.rejects(buildWasiSysroot({waffle,sdk,output,profile:"shared-pic"}),/Sysroot inputs changed/);
      await save({...shared,growthImport:"wrong.namespace"});
      await assert.rejects(buildWasiSysroot({waffle,sdk,output,profile:"shared-pic"}),/Sysroot inputs changed/);
      console.log("profile isolation and incompatible receipt rejection passed");
    `], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, timeout: 10000 });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("profile isolation and incompatible receipt rejection passed");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
