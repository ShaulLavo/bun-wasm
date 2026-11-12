import { spawnSync } from "node:child_process";

export function run(command: string[], env: NodeJS.ProcessEnv = process.env): void {
  console.log(`\n> ${command.join(" ")}`);
  const result = spawnSync(command[0]!, command.slice(1), { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command[0]} failed: ${result.signal ?? result.status}`);
}


export async function runCargo(command: string[], abi: "host" | "wasm32-wasip1", env: NodeJS.ProcessEnv): Promise<void> {
  if (!env.BUNWASM_TLS_CARGO_RECORD_DIR) { run(command, env); return; }
  console.log(`\n> ${command.join(" ")}`);
  const { recordCargo } = await import("./tls-probe-cargo.ts");
  await recordCargo(command, abi, env);
}
