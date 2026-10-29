let __bunwasm_s = 0;
export async function plain(a, b) {
  f(__bunwasm_resume(__bunwasm_capture(), await a), __bunwasm_resume(__bunwasm_capture(), await b));
  if (__bunwasm_resume(__bunwasm_capture(), await a))
    g(`${__bunwasm_resume(__bunwasm_capture(), await b)}`);
  const y = (__bunwasm_resume(__bunwasm_capture(), await a)).y;
  __bunwasm_resume(__bunwasm_capture(), await a.y());
  __bunwasm_resume(__bunwasm_capture(), await __bunwasm_resume(__bunwasm_capture(), await a));
  __bunwasm_resume(__bunwasm_capture(), await b);
  const inner = async (x = async () => __bunwasm_resume(__bunwasm_capture(), await b)) => __bunwasm_resume(__bunwasm_capture(), await x());

  class C {
    field = async () => __bunwasm_resume(__bunwasm_capture(), await a);
  }
  return [y, inner, C];
}
export async function asi(y, z, x) {
  f(y);
  __bunwasm_resume(__bunwasm_capture(), await z);
  __bunwasm_resume(__bunwasm_capture(), await x(y));
}
export async function handlers(a, b) {
  let __bunwasm_s = 0;
  try {
    __bunwasm_resumed(await __bunwasm_id(a, __bunwasm_s = __bunwasm_capture()), __bunwasm_s, __bunwasm_s = 0);
  } catch {
    __bunwasm_caught(__bunwasm_s, __bunwasm_s = 0);
    __bunwasm_resumed(await __bunwasm_id(b, __bunwasm_s = __bunwasm_capture()), __bunwasm_s, __bunwasm_s = 0);
  } finally {
    __bunwasm_caught(__bunwasm_s, __bunwasm_s = 0);
    h();
  }
  try {
    __bunwasm_resumed(await __bunwasm_id((__bunwasm_resumed(await __bunwasm_id(a, __bunwasm_s = __bunwasm_capture()), __bunwasm_s, __bunwasm_s = 0))(b), __bunwasm_s = __bunwasm_capture()), __bunwasm_s, __bunwasm_s = 0);
  } catch ({ message }) {
    __bunwasm_caught(__bunwasm_s, __bunwasm_s = 0);
    g(message);
  }
  try {
    try {
      __bunwasm_resumed(await __bunwasm_id(a, __bunwasm_s = __bunwasm_capture()), __bunwasm_s, __bunwasm_s = 0);
    } finally {
      __bunwasm_caught(__bunwasm_s, __bunwasm_s = 0);
      __bunwasm_resumed(await __bunwasm_id(b, __bunwasm_s = __bunwasm_capture()), __bunwasm_s, __bunwasm_s = 0);
    }
  } catch (_e) {
    __bunwasm_caught(__bunwasm_s, __bunwasm_s = 0);
  }
  return __bunwasm_resumed(await __bunwasm_id(b, __bunwasm_s = __bunwasm_capture()), __bunwasm_s, __bunwasm_s = 0);
}
export async function classify(a) {
  const nested = async () => {
    let __bunwasm_s = 0;
    try {
      __bunwasm_resumed(await __bunwasm_id(a, __bunwasm_s = __bunwasm_capture()), __bunwasm_s, __bunwasm_s = 0);
    } catch {
      __bunwasm_caught(__bunwasm_s, __bunwasm_s = 0);
    }
  };
  function sync() {
    try {
      a();
    } catch {}
  }

  class K {
    static {
      try {
        a();
      } catch {}
    }
  }
  __bunwasm_resume(__bunwasm_capture(), await a);
  return [nested, sync, K];
}
export async function* generator(a) {
  let __bunwasm_s = 0;
  try {
    __bunwasm_id(yield __bunwasm_id(a, __bunwasm_s = __bunwasm_capture()), __bunwasm_s = 0);
    __bunwasm_id(yield* __bunwasm_id(a, __bunwasm_s = __bunwasm_capture()), __bunwasm_s = 0);
    yield;
    __bunwasm_resumed(await __bunwasm_id(a, __bunwasm_s = __bunwasm_capture()), __bunwasm_s, __bunwasm_s = 0);
  } finally {
    __bunwasm_caught(__bunwasm_s, __bunwasm_s = 0);
    g();
  }
}
export async function* plainGenerator(a) {
  yield a;
  __bunwasm_resume(__bunwasm_capture(), await a);
}
export async function loops(xs, a) {
  let __bunwasm_s = 0;
  { let __bunwasm_c = __bunwasm_capture();
  for await (const x of __bunwasm_id(xs, __bunwasm_s = __bunwasm_c)) {
    try {
      __bunwasm_resume(__bunwasm_c, __bunwasm_s = 0);
      g(x);
    } finally { __bunwasm_s = __bunwasm_c = __bunwasm_capture(); }
  }
  __bunwasm_resume(__bunwasm_c, 0);
  __bunwasm_s = 0;
  }
    { let __bunwasm_c = __bunwasm_capture();
  outer:
    for await (const _x of __bunwasm_id(__bunwasm_resumed(await __bunwasm_id(a, __bunwasm_s = __bunwasm_capture()), __bunwasm_s, __bunwasm_s = 0), __bunwasm_s = __bunwasm_c)) {
      try {
        __bunwasm_resume(__bunwasm_c, __bunwasm_s = 0);
        { let __bunwasm_c = __bunwasm_capture();
        for await (const y of __bunwasm_id(xs, __bunwasm_s = __bunwasm_c)) {
          try {
            __bunwasm_resume(__bunwasm_c, __bunwasm_s = 0);
            if (y)
              continue outer;
            break;
          } finally { __bunwasm_s = __bunwasm_c = __bunwasm_capture(); }
        }
        __bunwasm_resume(__bunwasm_c, 0);
        __bunwasm_s = 0;
        }
      } finally { __bunwasm_s = __bunwasm_c = __bunwasm_capture(); }
    }
  __bunwasm_resume(__bunwasm_c, 0);
  __bunwasm_s = 0;
  }
    { let __bunwasm_c = __bunwasm_capture();
  a:
    b:
      for await (const z of __bunwasm_id(xs, __bunwasm_s = __bunwasm_c)) {
        try {
          __bunwasm_resume(__bunwasm_c, __bunwasm_s = 0);
          if (z)
            continue b;
          break a;
        } finally { __bunwasm_s = __bunwasm_c = __bunwasm_capture(); }
      }
  __bunwasm_resume(__bunwasm_c, 0);
  __bunwasm_s = 0;
  }
  switch (a) {
    case 1:
      { let __bunwasm_c = __bunwasm_capture();
      for await (const _w of __bunwasm_id(xs, __bunwasm_s = __bunwasm_c)) {
        try {
          __bunwasm_resume(__bunwasm_c, __bunwasm_s = 0);
          ;
        } finally { __bunwasm_s = __bunwasm_c = __bunwasm_capture(); }
      }
      __bunwasm_resume(__bunwasm_c, 0);
      __bunwasm_s = 0;
      }
  }
}
try {
  __bunwasm_resumed(await __bunwasm_id(plain(1, 2), __bunwasm_s = __bunwasm_capture()), __bunwasm_s, __bunwasm_s = 0);
} catch {
  __bunwasm_caught(__bunwasm_s, __bunwasm_s = 0);
}
{ let __bunwasm_c = __bunwasm_capture();
for await (const x of __bunwasm_id([1], __bunwasm_s = __bunwasm_c)) {
  try {
    __bunwasm_resume(__bunwasm_c, __bunwasm_s = 0);
    g(x);
  } finally { __bunwasm_s = __bunwasm_c = __bunwasm_capture(); }
}
__bunwasm_resume(__bunwasm_c, 0);
__bunwasm_s = 0;
}
