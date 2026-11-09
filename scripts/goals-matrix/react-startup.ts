import { join, resolve } from "node:path";
import { ownedCommand } from "./lifetime";

const renderLimitMs = 6900;

export function reactStartupURL(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error("React startup requires an HTTP URL");
  const engine = url.searchParams.get("engine");
  if (engine && engine !== "browser") throw new Error("React startup budget is calibrated for the Browser engine");
  return url.href;
}

export function reactStartupCommand(url: string, output: string): string[] {
  return ["bun", resolve(import.meta.dir, "../measure-react-startup.ts"), "--url", url,
    "--samples", "3", "--deadline-ms", "30000", "--limit-ms", String(renderLimitMs), "--output", join(output, "react-startup.json")];
}

export async function checkReactStartup(url: string, output: string, signal: AbortSignal): Promise<void> {
  await ownedCommand(reactStartupCommand(url, output), signal, 210_000, true);
}
