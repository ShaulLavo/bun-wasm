import { oxcOutputs } from "../../scripts/real-oxc-consumer";
import { OWNERSHIP_ENTRY } from "./parser-reserve-ownership";

export const ADDRESS_SPACE = "address-space";
export const ADDRESS_SPACE_ENTRY = `${ADDRESS_SPACE}/guest.ts`;
export const DEBT_ENTRY = "failed-stop.ts";

export function sharedWasmBrowserPlan(kind: string, oxcTree: string | undefined, override: string | undefined) {
  const entries = oxcTree !== undefined ? Object.keys(oxcOutputs) : override ? [override] : ["browser-guest.ts", OWNERSHIP_ENTRY, DEBT_ENTRY, ADDRESS_SPACE_ENTRY];
  return { entries, spiderMonkeyCanaries: kind === "spidermonkey" && oxcTree === undefined };
}
