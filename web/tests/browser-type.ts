import { playwright } from "./playground.mjs";

export function browserType(name: string) {
  if (name === "chromium" || name === "firefox" || name === "webkit") return playwright[name];
  throw new Error(`Unknown browser: ${name}`);
}
