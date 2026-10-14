import fn, { extra } from "./fn-export.js";
import lib, { greet, version } from "./cjs-lib.js";
import flagged, { other } from "./flagged.js";
export const result = [fn(), extra, typeof lib.greet, greet === lib.greet, version, flagged, other].join(" | ");
