const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const GeneratorFunction = Object.getPrototypeOf(function*() {}).constructor;
const AsyncGeneratorFunction = Object.getPrototypeOf(async function*() {}).constructor;
async function check(name, test) {
  try { if (!await test()) throw new Error("assertion"); console.log(name, "ok"); }
  catch (e) { console.log(name, "FAIL", String(e)); }
}
for (const [name, Ctor, prefix, suffix] of [
  ["function", Function, "return ", ""],
  ["async", AsyncFunction, "return ", ""],
  ["generator", GeneratorFunction, "yield ", ".next().value"],
  ["async generator", AsyncGeneratorFunction, "yield ", ".next()"],
]) {
  async function run(body) {
    const value = Ctor(body)();
    return name === "generator" ? value.next().value : name === "async generator" ? (await value.next()).value : value;
  }
  await check(name + " comment", async () => (await run(prefix + 'import/* comment */("./value.mjs")')).value === "adjacent");
  await check(name + " template", async () => (await run(prefix + '`raw import("fake") ${import("./value.mjs").then(m => m.value)}`')).startsWith("raw import"));
}
await check("await template", async () => await AsyncFunction('return `${(await import("./value.mjs")).value}`')() === "adjacent");
for (const [name, fn] of [
  ["local", Function('const globalThis = {}; return import("node:path")')],
  ["parameter", Function('globalThis', 'return import("node:path")').bind(null, {})],
  ["with", Function('scope', 'with(scope) { return import("node:path"); }').bind(null, new Proxy({}, {has() { return true; }, get() { return {}; }}))],
]) await check("shadow " + name, async () => (await fn()).sep === "/");
await check("symbol rejection", async () => {
  let promise;
  try { promise = Function('return import(Symbol("x"))')(); } catch { return false; }
  try { await promise; } catch (e) { return e instanceof TypeError; }
  return false;
});
await check("one coercion", async () => {
  let calls = 0;
  const value = await Function('s', 'return import(s)')({ toString() { calls++; return "./value.mjs"; } });
  return value.value === "adjacent" && calls === 1;
});
await check("falsy rejection", async () => {
  for (const token of [undefined, null, false, 0, ""]) {
    try { await Function('s', 'return import(s)')({ toString() { throw token; } }); return false; }
    catch (e) { if (e !== token) return false; }
  }
  return true;
});
