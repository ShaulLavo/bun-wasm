import { test as bunTest } from "bun:test";

/**
 * For package tests that run real builders, child processes and file work. Their limit only
 * catches a hang: shared CI runners can be many times slower than a workstation, so Bun's
 * 5 s default is a speed judgment these tests must not make.
 */
const HANG_CAP_MS = 60_000;

export function test(name: string, body: () => Promise<void> | void, timeout = HANG_CAP_MS): void {
  bunTest(name, body, timeout);
}
