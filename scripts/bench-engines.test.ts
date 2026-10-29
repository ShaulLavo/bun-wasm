import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture";
import { programProfile } from "../src/engine-kind";
import { expect, test } from "bun:test";
import { distribution, engineArtifacts, engineOrder, median, nativeControlAdapter, parseEngineSpecs, parseMicroOutput } from "./bench-engines";

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

test("six rounds counterbalance all three positions and directed adjacent pairs", () => {
  const engines = parseEngineSpecs(["quickjs=q.wasm", "jsc=j.wasm", "hermes=h.wasm"]);
  const orders = Array.from({ length: 6 }, (_, round) => engineOrder(engines, round).map(engine => engine.name));
  expect(new Set(orders.map(order => order.join(","))).size).toBe(6);
  for (const engine of engines) for (let position = 0; position < 3; position++) expect(orders.filter(order => order[position] === engine.name)).toHaveLength(2);
  const pairs = orders.flatMap(order => order.slice(0, -1).map((name, index) => `${name}/${order[index + 1]}`));
  expect(new Set(pairs).size).toBe(6);
  for (const pair of new Set(pairs)) expect(pairs.filter(value => value === pair)).toHaveLength(2);
  expect(engineOrder(engines, 6)).toEqual(engineOrder(engines, 0));
});

test("distributions retain noisy valid samples and use nearest-rank p90", () => {
  const values = [100, 1, 4, 3, 2, 5];
  expect(distribution(values)).toEqual({ n: 6, min: 1, median: 3.5, p90: 100, max: 100, mad: 1.5, flags: ["relative-mad-above-10-percent"] });
  expect(values[0]).toBe(100);
  expect(distribution([0])?.flags).toEqual(["fewer-than-six"]);
  expect(distribution([])).toBeNull();
  expect(() => distribution([NaN])).toThrow("finite");
});

test("native control runs real fixture bytes without any Wasm or engine label", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-native-control-"));
  try {
    await writeFile(join(directory, "hello.ts"), 'const message: string = "control-ok"; console.log(message);');
    const request = { engine: { name: "native-bun-control", path: process.execPath }, fixtureDir: directory,
      workload: { name: "hello-cold", precompiled: false, args: ["run", "/hello.ts"], output: () => ({}) } };
    const launch = nativeControlAdapter(process.execPath).launch(request);
    const child = Bun.spawnSync({ cmd: launch.command, env: launch.env });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString().trim()).toBe("control-ok");
    expect(launch.command).not.toContain("--wasm");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an existing output identity is rejected without overwriting evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-bench-output-"));
  try {
    const output = join(directory, "result.json");
    await writeFile(output, "retained-evidence");
    const child = Bun.spawnSync([process.execPath, join(import.meta.dirname, "bench-engines.ts"), "--native-control", "--runs", "1", "--output", output]);
    expect(child.exitCode).toBe(1);
    expect(await Bun.file(output).text()).toBe("retained-evidence");
  } finally { await rm(directory, { recursive: true, force: true }); }
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
