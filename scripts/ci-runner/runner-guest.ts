import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { imageVersion } from "./image.ts";

async function input(): Promise<unknown> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk.toString();
    if (text.length > 4096) throw new Error("Invalid runner configuration input");
  }
  return JSON.parse(text);
}

export function runnerEnvironment(): NodeJS.ProcessEnv {
  return { HOME: "/home/runner", PATH: "/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", ImageVersion: imageVersion, RUNNER_TEMP: "/work/t", TMPDIR: "/work/t" };
}

async function configure(): Promise<void> {
  const value = await input();
  if (typeof value !== "object" || value === null || !("token" in value) || !("name" in value) || typeof value.token !== "string" || typeof value.name !== "string" || !/^pc-bun-wasm-[a-f0-9-]{36}$/.test(value.name)) throw new Error("Invalid runner configuration");
  const copy = spawnSync("/usr/bin/cp", ["-r", "--preserve=mode,timestamps", "/opt/actions-runner/.", "/work/runner"], { stdio: "ignore" });
  if (copy.status !== 0) throw new Error("Cannot stage private runner");
  const result = spawnSync("/work/runner/bin/Runner.Listener", ["configure", "--unattended", "--url", "https://github.com/ShaulLavo/bun-wasm", "--name", value.name, "--labels", "self-hosted,linux,x64,pc,bun-wasm", "--work", "/work/w", "--ephemeral", "--disableupdate"], { cwd: "/work/runner", env: { ...runnerEnvironment(), ACTIONS_RUNNER_INPUT_TOKEN: value.token }, stdio: "ignore", timeout: 120_000 });
  if (result.status !== 0) throw new Error("Ephemeral registration failed");
}

export function validateRunnerSettings(text: string): void {
  const configured: unknown = JSON.parse(text.replace(/^\uFEFF/u, ""));
  if (typeof configured !== "object" || configured === null || !("ephemeral" in configured) || configured.ephemeral !== true || !("disableUpdate" in configured) || configured.disableUpdate !== true) throw new Error("Runner must be ephemeral with automatic updates disabled");
}

async function listen(): Promise<void> {
  const version = spawnSync("/work/runner/bin/Runner.Listener", ["--version"], { cwd: "/work/runner", env: runnerEnvironment(), encoding: "utf8" });
  if (version.status !== 0 || version.stdout.trim() !== "2.338.2") throw new Error("Unexpected runner version");
  validateRunnerSettings(readFileSync("/work/runner/.runner", "utf8"));
  const child = spawn("/work/runner/bin/Runner.Listener", ["run", "--startuptype", "service"], { cwd: "/work/runner", env: { ...runnerEnvironment(), ACTIONS_RUNNER_HOOK_JOB_STARTED: "/opt/bun-wasm-ci/guard-hook.sh" }, stdio: "inherit" });
  const status = await new Promise<number | null>((resolveExit, reject) => { child.once("error", () => reject(new Error("Cannot start runner"))); child.once("exit", resolveExit); });
  if (status !== 0) throw new Error("Ephemeral Listener failed");
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const task = process.argv[2] === "configure" ? configure : listen;
  task().catch(() => { process.stderr.write("Guest runner operation failed\n"); process.exitCode = 1; });
}
