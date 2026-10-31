import { watch } from "fs/promises";
import { watch as nodeWatch } from "node:fs/promises";
import fs from "node:fs";
console.log(typeof watch, watch === nodeWatch, watch === fs.promises.watch);
