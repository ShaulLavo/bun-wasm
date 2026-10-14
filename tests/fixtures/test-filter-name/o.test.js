import { test, describe } from "bun:test";
test("a", () => {});
test.only("b only", () => {});
describe("d", () => { test("c", () => {}); test.only("d only", () => {}); });
describe.only("e", () => { test("f", () => {}); });
