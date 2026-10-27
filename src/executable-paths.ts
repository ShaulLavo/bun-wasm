import type { Engine } from "../web/src/bun-executor.js";

/** Persistent executable locations shared by demo roots, their PATH and package installations. */
export const ENGINE_BIN: Readonly<Record<Engine, string>> = {
  browser: "/bin",
  quickjs: "/opt/bun/quickjs/bin",
  jsc: "/opt/bun/jsc/bin",
  hermes: "/opt/bun/hermes/bin",
};

export function bunEnvironment(env: Readonly<Record<string, string>>): Record<string, string> {
  return { NEXT_TELEMETRY_DISABLED: "1", ...env };
}

export function engineEnvironment(engine: Engine, env: Readonly<Record<string, string>>): Record<string, string> {
  const bin = ENGINE_BIN[engine];
  const path = env.PATH ?? "/bin:/usr/bin";
  return { ...env, PATH: path.split(":")[0] === bin ? path : `${bin}:${path}` };
}
