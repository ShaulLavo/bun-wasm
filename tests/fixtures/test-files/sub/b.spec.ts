import { test, expect } from "bun:test";
interface P { x: number }
test("ts pass", () => { const p: P = { x: 1 }; expect(p.x).toBe(1); });
