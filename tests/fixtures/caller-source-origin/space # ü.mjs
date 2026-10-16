import { callerSourceOrigin } from "bun:jsc";
export function helper() {
  return { origin: callerSourceOrigin() };
}
