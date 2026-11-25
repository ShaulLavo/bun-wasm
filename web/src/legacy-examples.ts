/**
 * SHA-256 of every older stock text of an example, by file name. A returning visitor's file with
 * one of these exact texts was never edited, so the playground upgrades it to the current
 * example (the old db.ts opened a shared todos.sqlite; the old files.ts wrote relative to the
 * shell's directory). Add the previous hash here whenever an example in examples.ts changes.
 * The texts behind these hashes are in web/tests/fixtures/legacy-examples.json.
 */
export const legacyExamples: Readonly<Record<string, readonly string[]>> = {
  // bun-wasm 7b25271e30bd41ca54d115d01d557084068cf930 (main before the showcase demos).
  "index.ts": ["8fb0f01a4a4d088dcdbe218057abfa5fb1d8122e9190363dcf29c1702bf35dd2"],
  "files.ts": ["edd6bf51fca254e64b691ba9135e498dff7eb89a3f9df83a89640d7c8b15f6ab"],
  "jsx.tsx": ["4937731a414ea4cf68583020e59b52c262dadb6286f7cae739dd576ef58e1dba"],
  "math.ts": ["8d756454f69bd840f9e0dffcc3bbd263f59ae2e12650949a0deec1c4a1f163af"],
  "math.test.ts": ["aae416293800eb595a22b644b2c3a3506f9cc5360e08e21c089845b20808caab"],
  "db.ts": ["0f76d5d3a7bdfbf78706e2854a6ec48cd72a1bf6ccfb94720b2fccb678be4a0a"],
};

/** Lowercase hex SHA-256 of a text's UTF-8 bytes. */
export async function textHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
