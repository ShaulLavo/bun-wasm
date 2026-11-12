import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assetIdentity } from "./assets";

const inventoryName = "goals-site-inventory.json";
async function inventory(root: string) {
  return (await assetIdentity(root)).filter(file => file.file !== inventoryName);
}

export async function writePreparedSiteInventory(root: string): Promise<void> {
  await writeFile(join(root, inventoryName), JSON.stringify(await inventory(root)));
}

export async function verifyPreparedSiteInventory(root: string): Promise<void> {
  const expected: unknown = JSON.parse(await readFile(join(root, inventoryName), "utf8"));
  if (JSON.stringify(expected) !== JSON.stringify(await inventory(root))) {
    throw new Error("Preparation error: prepared site inventory changed; prepare the matching components again");
  }
}
