import { constructionChecks } from "./contract.ts";

const checks = constructionChecks(Buffer);
for (const check of checks) check.run();
console.log("Buffer resizable construction checks passed");
