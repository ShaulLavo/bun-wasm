import { log } from "../util";
import { dep } from "shared-dep";
export function render(): string {
  log("home");
  return `<h1>home ${dep()}</h1>`;
}
