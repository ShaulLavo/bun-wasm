import type { Engine } from "./engine-kind.js";

/** Persistent executable locations shared by demo roots, their PATH and package installations. */
export const ENGINE_BIN: Readonly<Record<Engine, string>> = {
  browser: "/bin",
  quickjs: "/opt/bun/quickjs/bin",
  jsc: "/opt/bun/jsc/bin",
  spidermonkey: "/opt/bun/spidermonkey/bin",
};

export function bunEnvironment(env: Readonly<Record<string, string>>): Record<string, string> {
  return { NEXT_TELEMETRY_DISABLED: "1", ...env };
}

export function engineEnvironment(engine: Engine, env: Readonly<Record<string, string>>): Record<string, string> {
  return pathEnvironment(ENGINE_BIN[engine], env);
}

/** Puts `bin` first on the inherited `PATH`, once. */
export function pathEnvironment(bin: string, env: Readonly<Record<string, string>>): Record<string, string> {
  const path = env.PATH ?? "/bin:/usr/bin";
  return { ...env, PATH: path.split(":")[0] === bin ? path : `${bin}:${path}` };
}
