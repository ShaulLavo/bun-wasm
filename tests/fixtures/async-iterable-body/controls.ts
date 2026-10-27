export async function bodyControls() {
  const rows: string[] = [];
  function parts() {
    const chunks = [new Uint8Array([60,104,49,62]), "astro", new Uint8Array([60,47,104,49,62])];
    let index = 0;
    return { [Symbol.asyncIterator]() { return this; }, async next() { return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }; } };
  }
  const response = new Response(parts());
  rows.push(`type:${response.headers.get("content-type")}`);
  rows.push(`text:${await response.text()}`);
  rows.push(`used:${response.bodyUsed}`);
  const cloned = new Response(parts());
  const copy = cloned.clone();
  rows.push(`clone:${await cloned.text()}:${await copy.text()}`);
  let closed = false;
  async function* cancellable() {
    try { while (true) yield new Uint8Array([97]); }
    finally { closed = true; }
  }
  const reader = new Response(cancellable()).body!.getReader();
  await reader.read();
  await reader.cancel("stop");
  rows.push(`closed:${closed}`);
  const failure = new Error("body source failed");
  async function* failing() { yield new Uint8Array([97]); throw failure; }
  try { await new Response(failing()).text(); rows.push("error:missing"); }
  catch (error) { rows.push(`error:${error === failure}`); }
  let invalidClosed = false;
  async function* invalid() {
    try { yield 42; }
    finally { invalidClosed = true; }
  }
  try { await new Response(invalid()).text(); rows.push("invalid:missing"); }
  catch (error) { rows.push(`invalid:${error instanceof TypeError}:${invalidClosed}`); }
  rows.push(`plain:${await new Response({ value: 1 }).text()}`);
  return rows;
}
