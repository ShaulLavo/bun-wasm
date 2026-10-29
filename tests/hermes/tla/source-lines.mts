export function fail(): never {
  const message: string = "mapped module line";
  throw new Error(message);
}
fail();
