import assert from "node:assert/strict";

export function inspectProbeLinkMap(map: string) {
  const archives = new Map<string, Set<string>>();
  for (const match of map.matchAll(/(\S+\/(libc\+\+(?:abi)?\.a|libc\.a))\(/g)) {
    const [, path, name] = match;
    assert.ok(path && name);
    const paths = archives.get(name) ?? new Set<string>();
    paths.add(path);
    archives.set(name, paths);
  }
  for (const name of ["libc.a", "libc++.a"]) assert.equal(archives.get(name)?.size, 1, `one linked ${name}`);
  for (const [name, paths] of archives) {
    assert.ok(paths.size <= 1, `duplicate ${name}`);
    for (const path of paths) assert.ok(path.includes("/wasm32-wasip1/"), `non-WASI runtime ${path}`);
  }
  assert.ok(!map.includes("libstdc++") && !map.includes("__cxa_allocate_exception") && !/\(__cxa_throw\)/.test(map), "no second or exception-enabled C++ runtime");
  for (const name of ["SSL_do_handshake", "SSL_get_verify_result", "__getentropy", "__wasi_random_get"]) {
    assert.equal(Array.from(map.matchAll(new RegExp(`\\(${name}\\)`, "g"))).length, 1, `one linked ${name}`);
  }
  return Object.fromEntries(Array.from(archives, ([name, paths]) => [name, Array.from(paths)]));
}
