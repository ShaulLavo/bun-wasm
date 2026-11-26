import invariant from "tiny-invariant";
import { describePoint, type Point } from "./geometry";

const origin: Point = { x: 0, y: 0 };
invariant(origin.x === 0, "origin starts at zero");
const label: number = describePoint(origin);
console.log(label, origin.y);
