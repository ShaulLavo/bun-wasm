import { execFileSync } from "node:child_process";
import { run } from "./quality-command";
import { rustTestPackages } from "./rust-test-packages";

// rustfmt follows #[path] modules into vendor/bun unless skip_children is set.
// Every owned file, including new untracked files, is still passed explicitly.
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "crates/"], { encoding: "utf8" })
  .trim().split("\n").filter(file => file.endsWith(".rs"));
if (!files.length) throw new Error("No authored Rust files found");
run(["rustfmt", "--edition", "2024", "--config", "skip_children=true"].concat(process.argv.includes("--write") ? [] : ["--check"], files));
if (process.argv.includes("--write")) process.exit(0);
const version = execFileSync("cargo", ["machete", "--version"], { encoding: "utf8" }).trim();
if (version !== "0.9.2") throw new Error(`Expected cargo-machete 0.9.2, got ${version}`);
const env = { ...process.env };
// env.sh's WASI warning cap must not mask this host correctness gate.
delete env.CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS;
const jobs = process.env.QUALITY_RUST_JOBS ?? "1";
run(["cargo", "clippy", "--locked", "--workspace", "--all-targets", "--release", "--no-deps", "-j", jobs, "--", "-D", "warnings"], env);
// Every workspace member plus the path-patched crates with local tests, in one compile and run.
const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--no-deps", "--format-version", "1"], { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 }));
run(["cargo", "test", "--locked", "--release"].concat(rustTestPackages(metadata), ["-j", jobs]), env);
run(["cargo", "machete", "crates"], env);
