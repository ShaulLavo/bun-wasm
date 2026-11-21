import assert from "node:assert/strict";

type Web = Pick<typeof globalThis, "Request" | "ReadableStream">;
const url = "https://example.test/request";

function request(web: Web, body: BodyInit | null, redirect: RequestRedirect = "manual") {
  const init = { method: "POST", body, redirect, duplex: "half" };
  return new web.Request(url, init);
}

function stream(web: Web, text = "stream payload") {
  return new web.ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function copyCase(web: Web, body: BodyInit | null, text: string, materialize = false) {
  const source = request(web, body);
  const originalBody = materialize ? source.body : null;
  const copy = new web.Request(source, { headers: { "x-copy": "yes" } });
  assert.equal(copy.redirect, "manual");
  assert.equal(copy.method, "POST");
  assert.equal(copy.headers.get("x-copy"), "yes");
  assert.equal(source.headers.get("x-copy"), null);
  assert.notEqual(copy.headers, source.headers);
  assert.equal(copy.bodyUsed, false);
  // Bun copies the body: the source keeps its own, unused and unlocked.
  assert.equal(source.bodyUsed, false);
  assert.equal(source.body?.locked ?? false, false);
  assert.equal(await copy.text(), text);
  if (body === null) {
    assert.equal(copy.body, null);
    assert.equal(source.body, null);
    return;
  }
  if (originalBody) assert.equal(originalBody.locked, true);
  // Native Bun refuses to read an emptied "" source after the copy; that is not compared.
  if (text === "") return;
  assert.equal(await source.text(), text);
}

async function unusableCase(web: Web, state: "used" | "locked" | "disturbed") {
  const source = request(web, stream(web));
  const reader = state === "used" ? null : source.body!.getReader();
  if (state === "used") await source.text();
  if (state === "disturbed") {
    await reader!.read();
    reader!.releaseLock();
  }
  // Bun copies a used body as used, and refuses only a stream someone else holds.
  if (state === "locked") {
    assert.throws(() => new web.Request(source), TypeError);
    assert.throws(() => new web.Request(source, { headers: { "x-copy": "yes" }, body: undefined }), TypeError);
  } else {
    assert.equal(new web.Request(source).bodyUsed, true);
    assert.equal(new web.Request(source, { headers: { "x-copy": "yes" }, body: undefined }).bodyUsed, true);
  }
  assert.throws(() => source.clone(), TypeError);
  const replacement = new web.Request(source, { body: "replacement" });
  assert.equal(await replacement.text(), "replacement");
  const streamInit = { body: stream(web, "new stream"), duplex: "half" };
  const replacementStream = new web.Request(source, streamInit);
  assert.equal(await replacementStream.text(), "new stream");
  if (state === "locked") {
    reader!.releaseLock();
    assert.equal(await source.text(), "stream payload");
  }
}

export async function requestCopyContract(web: Web = globalThis) {
  await copyCase(web, null, "");
  await copyCase(web, "", "");
  await copyCase(web, new Uint8Array([65, 66, 67]), "ABC");
  await copyCase(web, new Uint8Array([65, 66, 67]), "ABC", true);
  await copyCase(web, stream(web), "stream payload");
  for (const state of ["used", "locked", "disturbed"] as const) await unusableCase(web, state);

  const source = request(web, stream(web));
  const replacement = new web.Request(source, { body: "override", redirect: "error" });
  assert.equal(await replacement.text(), "override");
  assert.equal(replacement.redirect, "error");
  assert.equal(source.bodyUsed, false);
  assert.equal(source.body?.locked, false);
  assert.equal(await source.text(), "stream payload");

  const original = request(web, stream(web));
  const clone = original.clone();
  assert.equal(original.bodyUsed, false);
  assert.equal(original.body?.locked, false);
  assert.equal(await clone.text(), "stream payload");
  assert.equal(await original.text(), "stream payload");
  assert.equal(clone.redirect, "manual");

  // The copy is a tee branch: cancelling both branches cancels the source with both reasons,
  // the source's own branch first.
  const reason = { kind: "copy cancelled" };
  let cancelled: unknown;
  let finishCancellation!: () => void;
  const cancellation = new Promise<void>(resolve => { finishCancellation = resolve; });
  const cancellable = request(web, new web.ReadableStream({ cancel(value) { cancelled = value; finishCancellation(); } }));
  const cancelledCopy = new web.Request(cancellable);
  const copyCancelled = cancelledCopy.body!.cancel(reason);
  const sourceCancelled = cancellable.body!.cancel("source cancelled");
  await Promise.all([copyCancelled, sourceCancelled, cancellation]);
  assert.deepEqual(Array.from(cancelled as unknown[]), ["source cancelled", reason]);

  const failure = new Error("source failed");
  const errored = request(web, new web.ReadableStream({ start(controller) { controller.error(failure); } }));
  const erroredCopy = new web.Request(errored);
  await assert.rejects(erroredCopy.text(), error => error === failure);
  return "request copy contract";
}
