import { checkPackages } from "./api.ts";

const failures = checkPackages("package");
if (failures.length) throw new AggregateError(failures, "Oxc public packages failed");
