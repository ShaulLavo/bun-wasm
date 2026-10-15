import { BuildConfig, file } from "bun";
import { Stats } from "node:fs";
const options: BuildConfig = { entrypoints: ["index.ts"] };
function size(stat: Stats): number { return stat.size; }
console.log("type imports erased:", options.entrypoints.length, typeof file, size({ size: 7 }));
