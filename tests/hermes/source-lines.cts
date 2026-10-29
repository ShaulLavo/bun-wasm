const message: string = "mapped CommonJS line";
function fail(): never {
  throw new Error(message);
}
fail();
