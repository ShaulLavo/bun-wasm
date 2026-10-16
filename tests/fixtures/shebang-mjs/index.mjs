#!/usr/bin/env bun π
import { join } from "node:path";
export { join as pathJoin } from "node:path";
import("node:path").then(m => import("./from.mjs").then(() => console.log(m.join("a", "b"), join("c", "d"))));
