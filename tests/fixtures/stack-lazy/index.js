const saved = Error.prepareStackTrace;
function check(name, test) {
  try { test(); console.log(name, "ok"); } catch (e) { console.log(name, "FAIL", String(e)); }
}
function assert(value) { if (!value) throw new Error("assertion"); }
check("capture lazy", () => {
  let calls = 0;
  Error.prepareStackTrace = () => { calls++; return "first"; };
  const holder = {};
  Error.captureStackTrace(holder);
  assert(calls === 0);
  const result = {};
  Error.prepareStackTrace = () => { calls++; return result; };
  assert(holder.stack === result && holder.stack === result && calls === 1);
});
check("capture late formatter", () => {
  Error.prepareStackTrace = undefined;
  const holder = {};
  Error.captureStackTrace(holder);
  Error.prepareStackTrace = () => null;
  assert(holder.stack === null && holder.stack === null);
});
check("capture throwing formatter", () => {
  let calls = 0;
  const token = {};
  Error.prepareStackTrace = () => { calls++; throw token; };
  const holder = {};
  Error.captureStackTrace(holder);
  assert(calls === 0);
  let thrown;
  try { holder.stack; } catch (e) { thrown = e; }
  assert(thrown === token && calls === 1);
  Error.prepareStackTrace = () => false;
  assert(holder.stack === false && holder.stack === false);
});
check("formatter consultation", () => {
  let consulted = 0;
  Object.defineProperty(Error, "prepareStackTrace", { configurable: true, get() { consulted++; return () => 0; } });
  const holder = {};
  Error.captureStackTrace(holder);
  assert(consulted === 0);
  assert(holder.stack === 0 && holder.stack === 0 && consulted === 1);
});
Object.defineProperty(Error, "prepareStackTrace", { value: saved, writable: true, configurable: true });
