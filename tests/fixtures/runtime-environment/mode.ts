export function resolveMode(defaultNodeEnv = "production") {
  const isNodeEnvSet = !!process.env.NODE_ENV;
  if (!isNodeEnvSet) process.env.NODE_ENV = defaultNodeEnv;
  const isProduction = process.env.NODE_ENV === "production";
  return { isNodeEnvSet, isProduction, esbuild: { jsxDev: !isProduction } };
}

export function environment() {
  return [process.env.NODE_ENV, process.env.BUN_ENV];
}

export async function buildStage() {
  await Promise.resolve();
}
