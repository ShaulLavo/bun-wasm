import { checkPackages } from "./api.ts";

const failures = checkPackages("binding");
new WebAssembly.Memory({ initial: 4000, maximum: 65536, shared: true });
console.log("shared memory created");
if (failures.length) throw new AggregateError(failures, "Oxc direct bindings failed");
