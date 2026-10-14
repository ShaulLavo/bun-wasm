import cond from "cond-pkg";
import { sub } from "cond-pkg/feature";
import legacy from "legacy-pkg";
import scoped from "@scope/sub";
import modField from "mod-field";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
console.log("exports import condition:", cond);
console.log("exports subpath:", sub);
console.log("main field:", legacy);
console.log("scoped package:", scoped);
console.log("module field (import):", modField);
console.log("exports require condition:", require("cond-pkg"));
console.log("main field (require):", require("mod-field"));
try {
  await import("cond-pkg/private");
} catch (err) {
  console.log("unexported subpath rejected:", err instanceof Error);
}
try {
  await import("not-installed");
} catch (err) {
  console.log("missing package:", err.message.includes("not-installed"));
}
