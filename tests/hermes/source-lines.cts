const message: string = "mapped CommonJS line";
function fail(): never {
  throw new Error(message);
}
try { fail(); } catch (error) {
  if (!(error instanceof Error)) throw error;
  const stack = String(error.stack);
  console.log("CommonJS source line", /source-lines\.cts:3:\d+/.test(stack));
}
