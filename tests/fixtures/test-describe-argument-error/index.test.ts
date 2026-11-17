import { describe, expect, test } from "bun:test";

test("registered before the error", () => {});

// An anonymous arrow function cannot name a block. The error is caught here and only its
// message is printed: engines report different source columns for the throwing call.
try {
  describe(() => {}, () => {
    test("should NOT run", () => {
      expect(true).toBe(true);
    });
  });
} catch (error) {
  console.log(`${(error as Error).name}: ${(error as Error).message}`);
}

test("registered after the error", () => {});
