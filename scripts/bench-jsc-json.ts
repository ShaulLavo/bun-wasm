import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { cpus, hostname, release } from "node:os";
const [donor, candidate, output] = process.argv.slice(2);
assert.ok(donor && candidate && output, "usage: json-bench.ts DONOR_DIR CANDIDATE_DIR OUTPUT.json");
const cpu = process.env.BENCH_CPU ?? "0";
const rounds = Number(process.env.BENCH_ROUNDS ?? 8);
assert.match(cpu, /^(0|[1-9]\d*)$/, "BENCH_CPU must name one logical CPU");
assert.ok(Number.isSafeInteger(rounds) && rounds > 0, "BENCH_ROUNDS must be a positive integer");
const host = { hostname: hostname(), kernel: release(), model: cpus()[Number(cpu)]?.model };
const names = ["small", "medium", "wide"] as const;
type Name = typeof names[number];
type Arm = "donor" | "candidate";
type Sample = { name: Name; arm: Arm; round: number; cpuMs: number; guestTid: string; threads: { tid: string; name: string; cpuMs: number }[]; elapsedMs: number; iterations: number; length: number; checksum: number };
const samples: Sample[] = [];
function counters(pid: number): Map<string, { name: string; cpuNs: bigint }> {
  return new Map(readdirSync(`/proc/${pid}/task`).map(tid => [tid, {
    name: readFileSync(`/proc/${pid}/task/${tid}/comm`, "utf8").trim(),
    cpuNs: BigInt(readFileSync(`/proc/${pid}/task/${tid}/schedstat`, "utf8").split(" ")[0]!),
  }]));
}
async function run(arm: Arm, name: Name, round: number, iterations: number): Promise<Sample> {
  const directory = resolve(arm === "donor" ? donor! : candidate!);
  const wasm = join(directory, "bun-jsc.wasm");
  const child = Bun.spawn(["taskset", "-c", cpu, join(directory, "bun-wasm"), "--wasm", wasm, "--engine", `jsc=${wasm}`,
    "--dir", `${join(import.meta.dir, "fixtures")}::/`, "--env", "PWD=/", "--env", "HOME=/", "--", "run", "/jsc-json-bench.ts", name, String(iterations)],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_WASM_CACHE_DIR: process.env.BUN_WASM_CACHE_DIR ?? resolve(donor!, "..", "wasmtime-cache") } });
  const deadline = setTimeout(() => child.kill(), 180_000);
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = "";
  async function until(marker: string): Promise<void> {
    while (!stdout.includes(marker)) {
      const next = await reader.read();
      assert.equal(next.done, false, `child ended before ${marker}: ${stdout}`);
      stdout += decoder.decode(next.value, { stream: true });
    }
  }
  async function resume(): Promise<void> {
    child.stdin.write("x");
    await child.stdin.flush();
  }
  try {
    await until("json-checkpoint start\n");
    const before = counters(child.pid);
    await resume();
    await until("json-checkpoint end\n");
    const after = counters(child.pid);
    const threads = Array.from(before, ([tid, start]) => ({ tid, name: start.name, cpuMs: Number(after.get(tid)!.cpuNs - start.cpuNs) / 1e6 }));
    threads.sort((a, b) => b.cpuMs - a.cpuMs);
    const guest = threads[0]!;
    assert.equal(guest.name, "bun-wasm");
    assert.ok(guest.cpuMs >= threads.reduce((sum, thread) => sum + thread.cpuMs, 0) * 0.99, "guest must own at least 99% of measured thread CPU");
    await resume();
    await child.stdin.end();
    await until("json-bench ");
    while (!stdout.slice(stdout.indexOf("json-bench ")).includes("\n")) {
      const next = await reader.read();
      assert.equal(next.done, false, stdout);
      stdout += decoder.decode(next.value, { stream: true });
    }
    assert.equal(await child.exited, 0, await stderr);
    const line = stdout.split("\n").find(line => line.startsWith("json-bench "));
    assert.ok(line, stdout);
    const value: unknown = JSON.parse(line.slice(11));
    assert.ok(value && typeof value === "object" && "elapsedMs" in value && "iterations" in value && "length" in value && "checksum" in value);
    const { elapsedMs, iterations: count, length, checksum } = value;
    assert.ok(typeof elapsedMs === "number" && typeof count === "number" && typeof length === "number" && typeof checksum === "number");
    return { name, arm, round, cpuMs: guest.cpuMs, guestTid: guest.tid, threads, elapsedMs, iterations: count, length, checksum };
  } finally {
    clearTimeout(deadline);
    child.kill();
    await reader.cancel();
    await child.exited;
  }
}
function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
}
const iterations: Record<string, number> = {};
for (const name of names) iterations[name] = (await run("donor", name, -1, 0)).iterations;
const pins = [donor, candidate].map(directory => ({ directory: resolve(directory),
  hashes: ["bun-wasm", "bun-jsc.wasm", "jsc-engine.wasm"].map(file => ({ file, sha256: createHash("sha256").update(readFileSync(join(directory, file))).digest("hex") })) }));
for (let round = 0; round < rounds; round++) {
  for (const name of names) {
    const order: Arm[] = round % 2 ? ["candidate", "donor"] : ["donor", "candidate"];
    for (const arm of order) {
      const sample = await run(arm, name, round, iterations[name]!);
      samples.push(sample);
      console.log(JSON.stringify({ round, name, arm, cpuMs: sample.cpuMs, elapsedMs: sample.elapsedMs }));
    }
  }
  writeFileSync(output, JSON.stringify({ clock: "Linux schedstat per-thread CPU interval between guest stdin barriers", host, rounds, cpu, iterations, pins, samples }, null, 2) + "\n");
}
const summary = names.map(name => {
  const baseline = samples.filter(sample => sample.name === name && sample.arm === "donor");
  const changed = samples.filter(sample => sample.name === name && sample.arm === "candidate");
  assert.ok(baseline.concat(changed).every(sample => sample.cpuMs >= 1000), `${name} must time at least one second of serialization`);
  assert.ok(baseline.concat(changed).every(sample => sample.length === baseline[0]!.length && sample.iterations === iterations[name]));
  const donorMs = median(baseline.map(sample => sample.cpuMs));
  const candidateMs = median(changed.map(sample => sample.cpuMs));
  return { name, donorMs, candidateMs, ratio: candidateMs / donorMs };
});
writeFileSync(output, JSON.stringify({ clock: "Linux schedstat per-thread CPU interval between guest stdin barriers", host, rounds, cpu, iterations, pins, samples, summary }, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
assert.ok(summary.every(row => row.ratio <= 1.03), "serialization interval regression exceeds the approved 3% gate");
