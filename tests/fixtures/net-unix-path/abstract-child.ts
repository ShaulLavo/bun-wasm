import { echo } from "./abstract-peer.ts";

// Process arguments cannot carry NUL, so the parent passes the name without its leading NUL.
console.log(await echo(`\0${process.argv[2]!}`, "child"));
