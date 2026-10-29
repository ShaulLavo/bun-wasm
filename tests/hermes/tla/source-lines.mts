export function fail(): never {
  const message: string = "mapped module line";
  throw new Error(message);
}
try { fail(); } catch (error) {
  if (!(error instanceof Error)) throw error;
  const stack = String(error.stack);
  console.log("module source line", /source-lines\.mts:3:\d+/.test(stack));
}
