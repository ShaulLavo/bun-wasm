import { inspect } from "node:util";

const error = "inspected rejection";
const promise = Promise.reject(error);
console.log("peek same", Bun.peek(promise) === error);
console.log("inspect rejected", inspect(promise).includes("<rejected>"));
