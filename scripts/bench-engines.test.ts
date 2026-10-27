import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture";
import { programProfile } from "../src/engine-kind";
import { expect, test } from "bun:test";
import { engineArtifacts, engineOrder, median, parseEngineSpecs, parseMicroOutput } from "./bench-engines";

test("micro parser checks every section and checksum", () => {
  const output = [
    "loop 10 ms (1534387362)",
    "regexp 11 ms (1431980)",
    "json 12 ms (4924030)",
    "alloc 13 ms (1400000)",
    "strings 14 ms (98799)",
  ].join("\n");
  expect(parseMicroOutput(output)).toEqual({ loop: 10, regexp: 11, json: 12, alloc: 13, strings: 14 });
  expect(() => parseMicroOutput(output.replace("1534387362", "0"))).toThrow("loop checksum");
});

test("median handles odd and even sample counts", () => {
  expect(median([9, 1, 5])).toBe(5);
  expect(median([9, 1, 5, 3])).toBe(4);
});

test("engine order alternates without mutating the input", () => {
  const engines = parseEngineSpecs(["quickjs=dist/bun.wasm", "jsc=dist/bun-jsc.wasm"]);
  expect(engineOrder(engines, 0).map(engine => engine.name)).toEqual(["quickjs", "jsc"]);
  expect(engineOrder(engines, 1).map(engine => engine.name)).toEqual(["jsc", "quickjs"]);
  expect(engines.map(engine => engine.name)).toEqual(["quickjs", "jsc"]);
  expect(() => parseEngineSpecs(["same=a.wasm", "same=b.wasm"])).toThrow("unique");
});

for (const kind of ["quickjs", "jsc"] as const) test(`${kind} metadata records both actual artifact identities`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-pair-metadata-"));
  try {
    const { core, side } = quickjsPair(kind);
    const profile = programProfile(kind);
    const path = join(directory, profile.core);
    await writeFile(path, core);
    await writeFile(join(directory, profile.side), side);
    const metadata = await engineArtifacts(path);
    if (metadata.kind === "single") throw new Error("Expected pair metadata");
    expect(metadata.kind).toBe(kind);
    expect(metadata.core.bytes + metadata.side.bytes).toBe(core.length + side.length);
    expect(metadata.side.path).toBe(join(directory, profile.side));
    expect(metadata.side.sha256).toBe(new Bun.CryptoHasher("sha256").update(side).digest("hex"));
    await rm(join(directory, profile.side));
    await expect(engineArtifacts(path)).rejects.toThrow(profile.side);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
