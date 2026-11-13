import { origin as introducedName } from "./line 13 > eval.ts";
import { origin as separatorName } from "./name@host.ts";

console.log("introduced-looking filename", introducedName() === new URL("./line 13 > eval.ts", import.meta.url).href);
console.log("frame separator filename", separatorName() === new URL("./name@host.ts", import.meta.url).href);
