import { cp, mkdtemp, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run, options, type Options } from "./run";
import { saveReport } from "./report";
import { validateReport, type Report } from "./model";
import { bounded } from "./execute";
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
async function command(args: string[], timeoutMs = 120_000): Promise<string> {
  const process = Bun.spawn(args, { stdout: "pipe", stderr: "inherit", timeout: timeoutMs, killSignal: "SIGTERM" });
  const output = await new Response(process.stdout).text();
  const code = await process.exited;
  if (code !== 0) throw new Error(`${args[0]} exited ${code}: ${output.slice(-3000)}`);
  return output;
}
export function combine(first: Report, second: Report): Report {
  validateReport(first); validateReport(second);
  if (JSON.stringify(first.source) !== JSON.stringify(second.source)) throw new Error("Shard sources and assets differ");
  const cells = first.cells.map((cell, index) => {
    const other = second.cells[index];
    if (!other || other.framework !== cell.framework || other.browser !== cell.browser || other.engine !== cell.engine) throw new Error("Shard ordering differs");
    if (other.status === "pending") return cell;
    if (cell.attempts.length && other.attempts.length) {
      const firstPrefix = JSON.stringify(cell.attempts) === JSON.stringify(other.attempts.slice(0, cell.attempts.length));
      const secondPrefix = JSON.stringify(other.attempts) === JSON.stringify(cell.attempts.slice(0, other.attempts.length));
      if (firstPrefix) return other;
      if (secondPrefix) return cell;
      throw new Error("Overlapping attempted shard boxes");
    }
    return other.attempts.length || cell.status === "pending" ? other : cell;
  });
  return { ...first, cells, resources: (first.resources ?? []).concat(second.resources ?? []) };
}
async function bundle(destination: string, source: Report["source"]): Promise<void> {
  await mkdir(join(destination, "web"), { recursive: true });
  const runner = await Bun.build({ entrypoints: [resolve(import.meta.dir, "run.ts")], outdir: destination, target: "bun", format: "esm", naming: "run.js", external: ["playwright"] });
  const server = await Bun.build({ entrypoints: [resolve("web/serve.ts")], outdir: join(destination, "web"), target: "bun", format: "esm", naming: "serve.ts" });
  if (!runner.success || !server.success) throw new AggregateError(runner.logs.concat(server.logs), "Fleet runner bundle failed");
  await writeFile(join(destination, "source.json"), JSON.stringify(source));
  await writeFile(join(destination, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { playwright: "1.64.1" } }));
}
async function mac(config: Options, source: Report["source"], local: string): Promise<Report> {
  const home = (await command(["mesh", "ssh", "mac", "--", "sh", "-lc", "printf '%s' \"$HOME\""])).trim();
  if (!home.startsWith("/Users/") || /[\r\n]/.test(home)) throw new Error("Unexpected Mac home from discovery");
  await command(["mesh", "ssh", "mac", "--", "zsh", "-lc", "python3 ~/.agents/skills/machine-fleet/scripts/availability.py check"], 15_000);
  const remote = `${home}/tmp/bun-wasm-goals-${crypto.randomUUID()}`;
  await command(["mesh", "ssh", "mac", "--", "mkdir", remote]);
  try {
    await bundle(local, source);
    await cp(config.root, join(local, "dist"), { recursive: true });
    if (config.resume) {
      await mkdir(join(local, "report"), { recursive: true });
      await cp(join(config.output, "TABLE.json"), join(local, "report/TABLE.json"));
    }
    for (const name of await readdir(local)) await command(["mesh", "cp", "-r", join(local, name), `mac:${remote}/${name}`]);
    const args = [`--root=${remote}/dist`, `--output=${remote}/report`, "--browsers=safari,iphone-safari", `--engines=${config.engines.join(",")}`, `--frameworks=${config.frameworks.join(",")}`, `--timeout-ms=${config.timeoutMs}`, `--asset-source=${config.assetSource}`, `--source-file=${remote}/source.json`].concat(config.deviceUDID ? [`--device-udid=${config.deviceUDID}`] : [], config.resume ? ["--resume"] : [], config.retryFailures ? ["--retry-failures"] : []);
    const script = `set -eu; cd ${quote(remote)}; export PATH="$HOME/.bun/bin:$PATH"; bun install --ignore-scripts; bun run.js ${args.map(quote).join(" ")}`;
    const child = Bun.spawn(["mesh", "ssh", "mac", "--", "zsh", "-lc", script], { stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    if (code !== 0 && code !== 1) throw new Error(`Mac runner exited ${code}`);
    await command(["mesh", "cp", "-r", `mac:${remote}/report`, local + "/collected"]);
    const report: Report = JSON.parse(await readFile(join(local, "collected/TABLE.json"), "utf8"));
    validateReport(report);
    await cp(join(local, "collected/logs"), join(config.output, "logs"), { recursive: true });
    await cp(join(local, "collected/native-cleanup.json"), join(config.output, "native-cleanup.json"));
    return report;
  } finally {
    // The remote runner owns driver/session/lock teardown before this task-owned staging is removed.
    await command(["mesh", "ssh", "mac", "--", "rm", "-rf", remote]);
    await command(["mesh", "ssh", "mac", "--", "test", "!", "-e", remote]);
    await writeFile(join(config.output, "fleet-cleanup.json"), JSON.stringify({ remote, stagingRemoved: true, at: new Date().toISOString() }, null, 2));
  }
}
export async function fleet(config: Options): Promise<Report> {
  if (!config.deviceUDID) throw new Error("Select an unclaimed simulator with T3 device_open and pass --device-udid");
  await mkdir(config.output, { recursive: true });
  const lock = join(config.output, ".goals-fleet-lock");
  await mkdir(lock);
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-goals-fleet-"));
  try {
    const local = await run({ ...config, browsers: ["chrome", "firefox"] });
    const native = await mac(config, local.source, scratch);
    const merged = combine(local, native);
    merged.command = "source env.sh && bun scripts/goals-matrix/fleet.ts " + process.argv.slice(2).map(quote).join(" ");
    await saveReport(config.output, merged);
    return merged;
  } finally {
    try { await bounded(() => rm(scratch, { recursive: true, force: true }), 30_000); }
    finally { await rmdir(lock); }
  }
}
if (import.meta.main) {
  const report = await fleet(options(process.argv.slice(2)));
  process.exitCode = report.cells.some(cell => cell.status === "fail") ? 1 : 0;
}
