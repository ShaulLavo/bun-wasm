import { readFileSync } from "node:fs";
import { join } from "node:path";

export function definition(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing ${signature}`);
  const body = source.indexOf("{", start);
  let depth = 1;
  let end = body;
  while (depth > 0 && ++end < source.length) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
  }
  if (depth !== 0) throw new Error(`Unclosed ${signature}`);
  return source.slice(start, end + 1);
}

function commonjsControl(root: string, shim: string) {
  const input = join(root, "lines.cpp");
  const output = join(root, "lines");
  const source = String.raw`#include <cassert>
#include <cstring>
#include <string>
#include <string_view>
#include <cstdint>
${definition(shim, "bool commonjs_body(")}
${definition(shim, "std::string commonjs_source(")}
int main() {
  const std::string prefix = "(function __bunwasm_cjs__(exports, require, module, __filename, __dirname) {\n\n";
  const std::string source = prefix + "return this;\n// body unchanged" + "\n})";
  std::string_view body;
  assert(commonjs_body(source.data(), source.size(), -1, &body));
  assert(body == "return this;\n// body unchanged");
  assert(body.data() == source.data() + prefix.size());
  const std::string adjusted = commonjs_source(source.data(), source.size(), body);
  assert(adjusted.size() == source.size() - 1);
  assert(adjusted.substr(prefix.size() - 1, body.size()) == body);
  assert(adjusted.substr(0, prefix.size() - 1) == prefix.substr(0, prefix.size() - 1));
  assert(adjusted.substr(adjusted.size() - 3) == "\n})");
  assert(!commonjs_body(source.data(), source.size(), -2, &body));
  assert(!commonjs_body(source.data(), source.size(), 0, &body));
  assert(!commonjs_body(source.data(), source.size(), 17, &body));
  assert(!commonjs_body("42", 2, -1, &body));
  assert(!commonjs_body(source.data() + 1, source.size() - 1, -1, &body));
  assert(!commonjs_body(source.data(), source.size() - 1, -1, &body));
  const std::string empty = prefix + "\n})";
  assert(commonjs_body(empty.data(), empty.size(), -1, &body));
  assert(body.empty());
}
`;
  return { label: "c++", input, output, source, command: ["c++", "-std=c++20", "-Wall", "-Wextra", "-Werror", input, "-o", output] };
}

function finalizerControl(root: string, adapter: string) {
  const source = `use std::{cell::RefCell, collections::HashMap, rc::Rc};
thread_local! {
    static NATIVES: RefCell<HashMap<u32, Rc<dyn Fn()>>> = RefCell::new(HashMap::new());
    static DEAD: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
}
${definition(adapter, "fn drop_dead_natives()")}
struct Reenter;
impl Drop for Reenter {
    fn drop(&mut self) { NATIVES.with(|natives| { natives.borrow_mut().insert(2, Rc::new(|| {})); }); }
}
fn main() {
    let owned = Reenter;
    NATIVES.with(|natives| { natives.borrow_mut().insert(1, Rc::new(move || { let _ = &owned; })); });
    DEAD.with(|dead| dead.borrow_mut().push(1));
    drop_dead_natives();
    NATIVES.with(|natives| assert!(natives.borrow().contains_key(&2)));
    DEAD.with(|dead| assert!(dead.borrow().is_empty()));
    drop_dead_natives();
}
`;
  const input = join(root, "finalizer.rs");
  const output = join(root, "finalizer");
  return { label: "rustup", input, output, source, command: ["rustup", "run", "stable", "rustc", "--edition=2024", input, "-o", output] };
}

export function nativeControls(root: string, repository = process.cwd()) {
  const shim = readFileSync(join(repository, "crates/bunwasm-spidermonkey/cpp/engine.cpp"), "utf8");
  const adapter = readFileSync(join(repository, "crates/bunwasm-engine-spidermonkey/src/vm.rs"), "utf8");
  return [commonjsControl(root, shim), finalizerControl(root, adapter)];
}
