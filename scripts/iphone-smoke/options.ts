import { resolve } from "node:path";
import { options, type Options } from "../goals-matrix/run";
import { validateIphoneControl } from "../goals-matrix/iphone-transport";
import { liveSiteURL } from "../goals-matrix/iphone-live-proxy";

export const deviceUDID = "C4D2FFD4-A0D2-4608-B180-35854521B830";
export const phaseTimeoutMs = 300_000;
export const installTimeoutMs = 600_000;
/** Local mode reads a prepared build and its recorded commit. Live mode reads a deployed site. */
type SmokeTarget = { mode: "local"; root: string; sourceFile: string } | { mode: "live"; url: string };
export interface SmokeOptions {
  matrix: Options;
  control: string;
  agent: string;
  thread: string;
  target: SmokeTarget;
}
const localOnly = ["root", "source-file", "asset-source"];
export function smokeOptions(args: readonly string[]): SmokeOptions {
  const values = new Map<string, string>();
  const allowed = ["root", "output", "source-file", "iphone-control-url", "iphone-agent-command", "device-udid", "mac-thread", "asset-source", "base-url"];
  for (const arg of args) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match?.[1] || !match[2] || !allowed.includes(match[1]) || values.has(match[1])) throw new Error(`Expected a unique --name=value smoke option, received ${arg}`);
    values.set(match[1], match[2]);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (!value?.trim()) throw new Error(`Missing --${key}`);
    return value;
  };
  if (required("device-udid").toUpperCase() !== deviceUDID) throw new Error(`Smoke is restricted to simulator ${deviceUDID}`);
  const control = required("iphone-control-url"), agent = required("iphone-agent-command");
  validateIphoneControl(control, agent);
  const thread = required("mac-thread");
  if (/[\r\n\0]/.test(thread) || Buffer.byteLength(thread) > 1024) throw new Error("--mac-thread must be a single-line T3 thread ID");
  const output = resolve(required("output"));
  const target = smokeTarget(values, required);
  const inputs = target.mode === "live" ? [`--asset-source=${target.url}`]
    : [`--root=${target.root}`, `--source-file=${target.sourceFile}`, `--asset-source=${values.get("asset-source") ?? target.root}`];
  const matrix = options([`--output=${output}`].concat(inputs, [
    "--browsers=iphone-safari", "--engines=browser,quickjs", "--frameworks=vite-react,hono",
    `--timeout-ms=${phaseTimeoutMs}`, `--install-timeout-ms=vite-react:${installTimeoutMs},hono:${installTimeoutMs}`,
    `--device-udid=${deviceUDID}`, `--iphone-control-url=${control}`, `--iphone-agent-command=${agent}`]));
  return { matrix, control, agent, thread, target };
}
function smokeTarget(values: ReadonlyMap<string, string>, required: (key: string) => string): SmokeTarget {
  const base = values.get("base-url");
  if (base === undefined) return { mode: "local", root: resolve(required("root")), sourceFile: resolve(required("source-file")) };
  const mixed = localOnly.filter(key => values.has(key));
  if (mixed.length) throw new Error(`--base-url tests a deployed site; remove --${mixed.join(", --")}`);
  return { mode: "live", url: liveSiteURL(base) };
}
