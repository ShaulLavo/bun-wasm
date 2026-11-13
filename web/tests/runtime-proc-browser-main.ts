import { isHostedPage, startPage } from "waffle/testing/page-runner/page";
import { createRuntimeProcPageSuite, observeRuntimeProcErrors } from "./runtime-proc-page-suite";

if (isHostedPage()) {
  startPage(createRuntimeProcPageSuite(async name => {
    const { runRuntimeProcCase } = await import("./runtime-proc-case-runner");
    return runRuntimeProcCase(name);
  }, observeRuntimeProcErrors()));
} else {
  const { runRuntimeProcCase } = await import("./runtime-proc-case-runner");
  await runRuntimeProcCase();
}
