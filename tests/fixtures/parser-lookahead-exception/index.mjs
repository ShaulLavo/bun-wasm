// QuickJS's arrow-function lookahead reads `/ v,` after the `else` keyword as an
// unterminated regexp. The real parse succeeds, and the guess must not leave a
// SyntaxError for the next module import to throw (@vercel/nft's static-eval.js).
import divided from "./lib/divided.cjs";

console.log("divided:", divided.else, divided.then);
const later = await import("./lib/later.mjs");
console.log("later import:", later.value);
