import { smokeOptions } from "./iphone-smoke/options";
import { smoke } from "./iphone-smoke/run";
import { smokeCases } from "./iphone-smoke/model";
import { boxId } from "./goals-matrix/catalog";

if (import.meta.main) {
  if (process.argv.slice(2).join() === "--list") {
    process.stdout.write(smokeCases.map(boxId).join("\n") + "\n");
  } else {
    const result = await smoke(smokeOptions(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ status: result.status, failedPhase: result.failedPhase, reportPath: result.reportPath }) + "\n");
    process.exitCode = result.status === "green" ? 0 : 1;
  }
}
