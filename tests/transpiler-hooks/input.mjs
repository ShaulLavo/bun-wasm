// Printer input for the browser engine's async-context hooks (vendor patch
// 0008). scripts/test-transpiler-example.sh prints it with --await-hooks and
// compares the result with expected.mjs.
"use strict";

// Plain: no own try or for await, so the two-argument form.
export async function plain(a, b) {
  f(await a, await b);
  if (await a) g(`${await b}`);
  const y = (await a).y;
  await a.y();
  await await a;
  await (a, b);
  const inner = async (x = async () => await b) => await x();
  class C { field = async () => await a; }
  return [y, inner, C];
}

// ASI: the hooks never introduce a line break decision.
export async function asi(y, z, x) {
  y
  await z
  await x
  (y)
}

// S: every await and handler is hooked. `__bunwasm_s` would follow the
// directive prologue, but Bun drops this redundant one from a module.
export async function handlers(a, b) {
  "use strict";
  try {
    await a; // comment after the operand
  } catch {
    await b;
  } finally {
    h();
  }
  try {
    await (await a)(b);
  } catch ({ message }) {
    g(message);
  }
  try {
    try { await a; } finally { await b; }
  } catch (e) {}
  return await b;
}

// Nested functions do not make their parent S, and a sync function nested in
// an S body never touches its `__bunwasm_s`.
export async function classify(a) {
  const nested = async () => { try { await a; } catch {} };
  function sync() { try { a(); } catch {} }
  class K { static { try { a(); } catch {} } }
  await a;
  return [nested, sync, K];
}

// Async generators: yield with an operand is hooked; a bare yield is not.
export async function* generator(a) {
  try {
    yield a;
    yield* a;
    yield;
    await a;
  } finally {
    g();
  }
}

export async function* plainGenerator(a) {
  yield a;
  await a;
}

// for await: block and non-block bodies, labels, nested loops, an await in
// the iterable. (Bun's parser rejects `continue a` to the outer label of a
// label chain, which ECMAScript allows.)
export async function loops(xs, a) {
  for await (const x of xs) g(x);
  outer: for await (const x of await a) {
    for await (const y of xs) {
      if (y) continue outer;
      break;
    }
  }
  a: b: for await (const z of xs) { if (z) continue b; break a; }
  switch (a) { case 1: for await (const w of xs) {} }
}

// Top-level await with a handler: the module body is S.
try {
  await plain(1, 2);
} catch {}
for await (const x of [1]) g(x);
