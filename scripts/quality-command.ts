import { spawnSync } from "node:child_process";

export function run(command: string[], env: NodeJS.ProcessEnv = process.env): void {
  console.log(`\n> ${command.join(" ")}`);
  const result = spawnSync(command[0]!, command.slice(1), { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command[0]} failed: ${result.signal ?? result.status}`);
}
