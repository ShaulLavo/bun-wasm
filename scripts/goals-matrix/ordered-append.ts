import { appendFile } from "node:fs/promises";

/**
 * Append evidence records to one file in call order. Concurrent appendFile calls can complete
 * out of order, which would put an earlier stage after the observation that explains a failure.
 * A failed write does not stop later records; a stalled one delays them.
 */
export function orderedAppender(path: string): (text: string) => Promise<void> {
  let tail: Promise<unknown> = Promise.resolve();
  return text => {
    const write = tail.then(() => appendFile(path, text));
    tail = write.catch(() => undefined);
    return write;
  };
}
