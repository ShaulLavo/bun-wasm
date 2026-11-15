import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { repo } from "./paths";
const files = ["qualification.ts", "transforms.ts", "collector.ts", "capture.ts", "inputs.ts", "instrument-build.ts", "supervise.ts", "teardown.ts"].map(name => join(import.meta.dir, name));
execFileSync(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--target", "ESNext", "--module", "Preserve", "--moduleResolution", "bundler", "--allowImportingTsExtensions", "--types", "bun", "--typeRoots", join(repo, "node_modules/@types"), "--lib", "ESNext,DOM,WebWorker"].concat(files), { stdio: "inherit", cwd: repo });
