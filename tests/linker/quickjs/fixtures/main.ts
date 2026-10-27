import { value } from "./value.ts";

const promised: number = await Promise.resolve(value).then((number) => number + 1);
const timed: number = await new Promise((resolve) => setTimeout(() => resolve(promised + 1), 5));
console.log(timed);
