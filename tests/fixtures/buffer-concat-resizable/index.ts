import { checkResizableConcat } from "./check.ts";

checkResizableConcat(Buffer);
console.log("concat sizes captured views after all getters shrink their backing");
