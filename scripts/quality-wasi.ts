import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run, runCargo } from "./quality-command";
import { verifyWasiLint } from "./quality-wasi-probe";

const sdk = process.env.WASI_SDK_PATH;
if (!sdk) throw new Error("WASI_SDK_PATH is required; source env.sh first");
const version = readFileSync(join(sdk, "VERSION"), "utf8").split("\n")[0];
if (version !== "34.0") throw new Error(`Expected WASI SDK 34.0, got ${version}`);
const env: NodeJS.ProcessEnv = { ...process.env, WASI_SDK: sdk, CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS: "-C link-self-contained=no" };
delete env.RUSTFLAGS;
delete env.CARGO_ENCODED_RUSTFLAGS;
const packages = ["cli", "runtime", "build", "glue", "posix", "semver", "crypto-sys", "transpiler", "bun-jsc", "bun-jsc-macros"];
const command = ["cargo", "clippy", "--locked", "--target", "wasm32-wasip1"]
  .concat(packages.flatMap((name) => ["-p", `bunwasm-${name}`]), ["-j", process.env.QUALITY_RUST_JOBS ?? "1"]);
run(command.concat(["--no-deps", "--", "-D", "warnings"]), env);
await runCargo(command.concat(["--no-default-features", "--features", "bunwasm-cli/engine-host,bunwasm-cli/bun-transpiler,bunwasm-cli/bun-build", "--no-deps", "--", "-D", "warnings"]), "wasm32-wasip1", env);

await verifyWasiLint(["cargo", "clippy", "--locked", "--target", "wasm32-wasip1", "-p", "bunwasm-posix", "--no-deps", "--", "-D", "warnings"], env);
