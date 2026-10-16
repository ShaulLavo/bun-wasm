#!/usr/bin/env bun
import("node:path").then(m => {
  require("./from.cjs");
  console.log(m.join("a", "b"));
});
