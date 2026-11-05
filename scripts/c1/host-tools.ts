import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { requireFile } from "./identity.ts";
import { HOST_TOOL_NAMES, type HostToolName, type HostTools } from "./replay.ts";

/**
 * Host tools are their own domain, separate from the product's input
 * manifest: declared in the replay contract at absolute paths, checked by
 * bytes, execute permission and version line in the consumer environment,
 * and called only by those paths. A tool the consumer environment's PATH
 * also finds must resolve to the declared file, so nothing that still runs a
 * tool by name (process inventory, for one) reaches a different binary.
 */
export interface ObservedHostTool { readonly path: string; readonly bytes: number; readonly sha256: string; readonly versionLine: string }

class HostToolError extends Error {}
function fail(message: string): never { throw new HostToolError(message); }

function onPath(pathList: string | undefined, name: string): string | undefined {
  const directory = (pathList ?? "").split(":").filter(Boolean).find(entry => existsSync(join(entry, name)));
  return directory === undefined ? undefined : realpathSync(join(directory, name));
}
function versionLine(path: string, args: readonly string[], env: Readonly<Record<string, string>>): string {
  const probe = spawnSync(path, args, { env, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
  if (probe.error || probe.status !== 0) fail(`host tool ${path} version probe failed: ${probe.error?.message ?? `exit ${String(probe.status)}`}`);
  return probe.stdout.split("\n")[0]?.trim() ?? "";
}
export function admitHostTool(tools: HostTools, name: HostToolName, env: Readonly<Record<string, string>>): ObservedHostTool {
  const declared = tools[name];
  const file = requireFile(declared, `host tool ${name}`);
  try { accessSync(file.path, constants.X_OK); } catch { fail(`host tool ${name} is not executable: ${file.path}`); }
  if (realpathSync(file.path) !== file.path) fail(`host tool ${name} must be named by its resolved path: ${file.path}`);
  const resolved = onPath(env.PATH, name);
  if (resolved !== undefined && resolved !== file.path) fail(`consumer PATH finds ${name} at ${resolved}, not the declared ${file.path}`);
  const line = versionLine(file.path, declared.version.args, env);
  if (line !== declared.version.line) fail(`host tool ${name} reports "${line}", not the declared "${declared.version.line}"`);
  return { path: file.path, bytes: file.bytes, sha256: file.sha256, versionLine: line };
}
/** Every declared tool, admitted in the environment the consumers receive, before any setup. */
export function admitHostTools(tools: HostTools, env: Readonly<Record<string, string>>): Record<HostToolName, ObservedHostTool> {
  return Object.fromEntries(HOST_TOOL_NAMES.map(name => [name, admitHostTool(tools, name, env)])) as Record<HostToolName, ObservedHostTool>;
}
