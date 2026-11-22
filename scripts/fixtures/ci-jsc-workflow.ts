import { readFileSync } from "node:fs";
import { expandNativeActions } from "./ci-native-workflow";

export function expandedCiWorkflow(): string {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  return expandNativeActions(read(".github/workflows/ci.yml"));
}
