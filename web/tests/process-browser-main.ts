import { isHostedPage, startPage } from "waffle/testing/page-runner/page";
import { runProcessCases } from "./process-case-runner";
import { createProcessPageSuite, observeProcessPageErrors } from "./process-page-suite";
import { createProcessConnectionCapture } from "./process-connection-capture";

if (isHostedPage()) {
  const diagnostic = window.__bunProcessPageDiagnostic;
  const capture = diagnostic ? createProcessConnectionCapture() : undefined;
  startPage(createProcessPageSuite(name => runProcessCases(name, { capture }), observeProcessPageErrors(), diagnostic));
} else await runProcessCases();
