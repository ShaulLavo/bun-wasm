#!/usr/bin/env bun π
import { join } from "node:path";
export { join as pathJoin } from "node:path";
import("node:path").then(m => import("./from.js").then(() => console.log(m.join("a", "b"), join("c", "d"))));
