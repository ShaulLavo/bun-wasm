import { test, expect } from "bun:test";
test("z ts", () => { expect("a" as string).toBe("a"); });
