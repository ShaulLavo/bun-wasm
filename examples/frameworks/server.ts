import { createServer } from "node:http";
import next from "next";
import { startBackends } from "./backends";
import { lifetime, listen, closeServer } from "./lifetime";
import { entryPort } from "./ports.server";

export async function startApp(mode: "dev" | "prod", scope = lifetime()) {
  try {
    await startBackends(scope);
    const app = next({ dev: mode === "dev", hostname: "127.0.0.1", port: entryPort, dir: import.meta.dir });
    scope.own(() => app.close());
    await app.prepare();
    const server = createServer(app.getRequestHandler());
    scope.own(() => closeServer(server));
    server.on("upgrade", app.getUpgradeHandler());
    await listen(server, entryPort);
    return scope;
  } catch (error) {
    await scope.close();
    throw error;
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "dev" && mode !== "prod") throw new Error("Usage: bun server.ts dev|prod");
  const scope = lifetime();
  const stop = () => { void scope.close().then(() => process.exit(0), error => { console.error(error); process.exit(1); }); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await startApp(mode, scope);
  process.stdout.write(`framework-routes ready http://127.0.0.1:${entryPort}\n`);
}
if (import.meta.main) await main();
