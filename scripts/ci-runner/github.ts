import { spawn } from "node:child_process";
import { repository } from "./policy.ts";

export async function github(path: string, method = "GET"): Promise<unknown> {
  const child = spawn("/work/ci-runner/bun-wasm/bin/gh", ["api", "--method", method, path], {
    env: { HOME: "/home/shaul", PATH: "/usr/bin:/bin", GH_PROMPT_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) child.kill("SIGKILL"); else chunks.push(chunk); });
  child.stderr.resume();
  const status = await new Promise<number | null>((resolveExit, reject) => { child.once("error", () => reject(new Error("GitHub API unavailable"))); child.once("exit", resolveExit); });
  if (status !== 0) throw new Error("GitHub API request failed");
  if (method === "DELETE") return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid GitHub API response");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid runner API object");
  return value as Record<string, unknown>;
}

export async function registrationToken(): Promise<string> {
  const result = record(await github(`/repos/${repository}/actions/runners/registration-token`, "POST"));
  if (typeof result.token !== "string" || !/^[a-zA-Z0-9_-]+$/.test(result.token)) throw new Error("Invalid short-lived registration token");
  return result.token;
}

export async function namedRunner(name: string): Promise<number | undefined> {
  if (!/^pc-bun-wasm-[a-f0-9-]{36}$/.test(name)) throw new Error("Invalid owned runner name");
  const result = record(await github(`/repos/${repository}/actions/runners?per_page=100`));
  if (!Array.isArray(result.runners) || typeof result.total_count !== "number" || result.total_count > 100) throw new Error("Runner inventory is incomplete");
  const matches = result.runners.map(record).filter(runner => runner.name === name);
  if (matches.length > 1) throw new Error("Duplicate owned runner registration");
  const runner = matches[0];
  if (!runner) return undefined;
  if (typeof runner.id !== "number" || !Number.isSafeInteger(runner.id) || runner.id <= 0) throw new Error("Invalid runner ID");
  return runner.id;
}

export async function removeRunner(name: string): Promise<void> {
  const id = await namedRunner(name);
  if (id === undefined) return;
  try {
    await github(`/repos/${repository}/actions/runners/${id}`, "DELETE");
  } catch (error) {
    if (await namedRunner(name) !== undefined) throw error;
  }
  if (await namedRunner(name) !== undefined) throw new Error("Owned runner registration remains");
}
