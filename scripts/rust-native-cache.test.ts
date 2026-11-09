import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");

function run(command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output) : reject(new Error(`${command.join(" ")} exited ${code}\n${output}`)));
  });
}

function cacheHits(stats: string): number {
  const hits = /^Cache hits\s+(\d+)/m.exec(stats)?.[1];
  if (hits === undefined) throw new Error(`Missing cache hit count\n${stats}`);
  return Number(hits);
}

async function fixture(root: string): Promise<void> {
  for (const name of ["native", "relay", "engine"]) await mkdir(join(root, name, "src"), { recursive: true });
  await writeFile(join(root, "Cargo.toml"), '[workspace]\nmembers=["native","relay","engine"]\nresolver="2"\n[profile.release]\nlto="thin"\ncodegen-units=4\npanic="abort"\n');
  await writeFile(join(root, "native/Cargo.toml"), '[package]\nname="native"\nversion="0.0.0"\nedition="2024"\n');
  await writeFile(join(root, "native/src/lib.rs"), 'unsafe extern "C" { pub fn native_value() -> i32; }\n');
  await writeFile(join(root, "native/build.rs"), `use std::{env, path::PathBuf, process::Command};
fn main() {
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    assert!(Command::new("cc").args(["-c", "value.c", "-o"]).arg(out.join("value.o")).status().unwrap().success());
    assert!(Command::new("ar").arg("crs").arg(out.join("libvalue.a")).arg(out.join("value.o")).status().unwrap().success());
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=value");
    println!("cargo:rerun-if-changed=value.c");
}
`);
  await writeFile(join(root, "relay/Cargo.toml"), '[package]\nname="relay"\nversion="0.0.0"\nedition="2024"\n[dependencies]\nnative={path="../native"}\n');
  await writeFile(join(root, "relay/src/lib.rs"), 'pub fn value() -> i32 { unsafe { native::native_value() } }\n');
  await writeFile(join(root, "engine/Cargo.toml"), '[package]\nname="engine"\nversion="0.0.0"\nedition="2024"\n[lib]\ncrate-type=["staticlib"]\n[dependencies]\nrelay={path="../relay"}\n');
  await writeFile(join(root, "engine/src/lib.rs"), '#[unsafe(no_mangle)] pub extern "C" fn engine_value() -> i32 { relay::value() }\n');
  await writeFile(join(root, "main.c"), '#include <stdio.h>\nextern int engine_value(void);\nint main(void) { printf("%d\\n", engine_value()); }\n');
}

test.each(["guest", "build-cache"])("%s keeps transitive native changes out of cached Rust staticlibs", async entrypoint => {
  expect(Bun.which("sccache"), "Install pinned sccache before running the native cache regression").not.toBeNull();
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-native-cache-"));
  const env = { ...process.env, CARGO_TARGET_DIR: join(root, "target"), SCCACHE_DIR: join(root, "cache"), SCCACHE_SERVER_UDS: join(root, "server"), SCCACHE_IDLE_TIMEOUT: "0", SCCACHE_SOCKET_ROOT: root, SCCACHE_RECACHE: undefined, SCCACHE_DISABLE: undefined, BUILD_CACHE: "1", RUSTC_WRAPPER: Bun.which("sccache")!, RUSTC_WORKSPACE_WRAPPER: "", CARGO_INCREMENTAL: "0" };
  try {
    await fixture(root);
    const selectEnvironment = ["bun", "-e", `import { guestToolEnvironment } from ${JSON.stringify(join(repository, "scripts/guest-source-manifest.ts"))}; console.log(guestToolEnvironment(${JSON.stringify(repository)}));`];
    const guestEnvironment = await run(selectEnvironment, root, env);
    expect(await run(["bash", "-c", `${guestEnvironment}\nexec "$@"`, "cache-regression"].concat(selectEnvironment), root, env)).toBe(guestEnvironment);
    const cargo = ["cargo", "build", "--offline", "--release", "-p", "engine", "-j", "2"];
    const build = entrypoint === "guest"
      ? ["bash", "-c", `${guestEnvironment}\nexec "$@"`, "cache-regression"].concat(cargo)
      : ["bash", join(repository, "scripts/with-build-cache.sh")].concat(cargo);
    for (const value of [11, 29]) {
      await writeFile(join(root, "native/value.c"), `int native_value(void) { return ${value}; }\n`);
      await run(build, root, env);
      await run(["cc", "main.c", "target/release/libengine.a", "-ldl", "-lpthread", "-lm", "-o", "result"], root, env);
      expect((await run([join(root, "result")], root, env)).trim()).toBe(String(value));
    }
    const archive = await readFile(join(root, "target/release/libengine.a"));
    expect(await run(build, root, env)).not.toContain("Compiling");
    const previousHits = entrypoint === "guest" ? cacheHits(await run(["sccache", "--show-stats"], root, env)) : 0;
    await rm(join(root, "target"), { recursive: true, force: true });
    const restored = await run(build, root, env);
    expect(await readFile(join(root, "target/release/libengine.a"))).toEqual(archive);
    const stats = entrypoint === "guest" ? await run(["sccache", "--show-stats"], root, env) : restored;
    expect(cacheHits(stats)).toBeGreaterThan(previousHits);
    console.log(`${entrypoint} changed C output from 11 to 29; unchanged build stayed fresh; cold target reused Rust objects.\n${stats}`);
  } finally {
    if (entrypoint === "guest") await run(["sccache", "--stop-server"], root, env).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test.each([
  { flags: ["--crate-type", "staticlib"] },
  { flags: ["--crate-type=staticlib"] },
  { flags: ["--crate-type", "rlib,staticlib"] },
  { flags: ["--crate-type=rlib,staticlib"] },
])("staticlib argument form $flags bypasses the cache", async ({ flags }) => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-native-cache-"));
  const env = { ...process.env, SCCACHE_DIR: join(root, "cache"), SCCACHE_SERVER_UDS: join(root, "server") };
  try {
    await writeFile(join(root, "probe.rs"), "pub fn value() -> u8 { 29 }\n");
    const compiler = (await run(["rustup", "which", "rustc"], root, env)).trim();
    await run([join(repository, "scripts/rustc-cache.sh"), compiler, "probe.rs", "--crate-name", "probe", "--emit=link", "--out-dir", root].concat(flags), root, env);
    expect((await readFile(join(root, "libprobe.a"))).byteLength).toBeGreaterThan(0);
    expect(existsSync(join(root, "server"))).toBe(false);
  } finally {
    await run(["sccache", "--stop-server"], root, env).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
