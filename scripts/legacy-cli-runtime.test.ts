import { test } from "bun:test";
import { resolve } from "node:path";
import { runLegacyCli } from "./legacy-cli";

test("the real legacy CLI passes all seven network fixtures in both slot modes", async () => {
  await runLegacyCli(resolve(import.meta.dir, ".."));
}, 1_200_000);
