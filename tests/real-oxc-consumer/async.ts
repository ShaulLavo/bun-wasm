import { createRequire } from "node:module";
import { exerciseAsyncConsumer, oxcAsyncConsumers } from "./api.ts";

const require = createRequire(import.meta.url);
const failures: unknown[] = [];
const results = await Promise.allSettled(oxcAsyncConsumers.map(async consumer => {
  try {
    const api: unknown = require(consumer.package);
    await exerciseAsyncConsumer(consumer, api);
    return `${consumer.name} package async API passed`;
  } catch (error) {
    console.error(`${consumer.package} async API failed`, error);
    throw error;
  }
}));
for (const result of results) {
  if (result.status === "fulfilled") console.log(result.value);
  else failures.push(result.reason);
}
if (failures.length) throw new AggregateError(failures, "Oxc async APIs failed");
