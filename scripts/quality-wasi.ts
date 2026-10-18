import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./quality-command";

const sdk = process.env.WASI_SDK_PATH;
if (!sdk) throw new Error("WASI_SDK_PATH is required; source env.sh first");
const version = readFileSync(join(sdk, "VERSION"), "utf8").split("\n")[0];
if (version !== "34.0") throw new Error(`Expected WASI SDK 34.0, got ${version}`);
const env = { ...process.env, WASI_SDK: sdk };
const command = ["cargo", "check", "--locked", "--target", "wasm32-wasip1", "-p", "bunwasm-cli", "-j", process.env.QUALITY_RUST_JOBS ?? "1"];
run(command, env);
run(command.concat(["--no-default-features", "--features", "engine-host,bun-transpiler,bun-build"]), env);
