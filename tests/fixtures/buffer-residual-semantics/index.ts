import { residualChecks } from "./checks.ts";

for (const check of residualChecks(Buffer)) {
  check.run();
  console.log(check.name);
}
