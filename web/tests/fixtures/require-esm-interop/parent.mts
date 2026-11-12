import value, { count, increment } from "./child.mts";
import common, { named } from "./common.cts";
export function run() {
  console.log(value(), count);
  increment();
  console.log(count, common.default, named);
}
export { value as default };
