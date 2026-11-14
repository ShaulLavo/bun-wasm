import { encodingChecks } from "./contract.ts";

const checks = encodingChecks(Buffer);
for (const check of checks) check.run();
console.log(`${checks.length} Buffer encoding binding checks passed`);
