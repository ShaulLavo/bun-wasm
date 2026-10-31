function collectGarbage() {
  const collect = globalThis.gc;
  if (!collect) throw new Error('GC must be enabled');
  collect();
}
async function lifetime() {
  const retained = (() => {
    const instance = new WebAssembly.Instance(fixture('table'), { env: { callback: (value: number) => value + 50 } });
    return { weak: new WeakRef(instance), entries: table(instance), callback: callable(table(instance).get(1)) };
  })();
  for (let i = 0; i < 12; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    collectGarbage();
  }
  equal(retained.weak.deref(), undefined, 'provider instance collected');
  equal(retained.callback(2), 52, 'retained callback callable after GC');
  equal(callable(retained.entries.get(0))(2), 3, 'retained table function after GC');
  const rooted = (() => {
    const object = { rooted: true };
    references.set(0, object);
    return new WeakRef(object);
  })();
  for (let i = 0; i < 12; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    collectGarbage();
  }
  equal(references.get(0), rooted.deref(), 'table externref rooted across GC');
  check(rooted.deref(), 'table retains object');
  console.log('PASS provider GC retains table/callable/callback and externref roots');
}
lifetime();
