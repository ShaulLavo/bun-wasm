import { resolve, join } from "node:path";
export const repo = resolve(import.meta.dir, "../../..");
export const root = process.env.SF_ROOT ?? "/work/tmp/bun-wasm-firefox-hosted-931cfb0e";
export const evidence = process.env.SF_EVIDENCE ?? "/work/reports/goals/storage-ci-20261114/firefox-hosted-first-event";
export const source = { head: "84ff8588028edcc013eb67aa4bb740b3a518b96d", tree: "da2d88afc92ac13281c58c386cdce60be40e8330" };
export const original = join(root, "browser-guest-site");
export const staged = join(root, "staged-site");
export const packet = join(root, "browser-program");
