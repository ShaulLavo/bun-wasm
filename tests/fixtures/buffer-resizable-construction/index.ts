import { constructionChecks } from "./contract.ts";

const checks = constructionChecks(Buffer);
for (const check of checks) check.run();
console.log("Buffer construction checks passed");
