// Test-only indirection installed BEFORE importing Waffle. Its saved intrinsics
// call these dispatchers; each trial changes only our local observer target.
// Do not import runtime modules here: they would capture the unobserved natives.
export const observedAtomics: Pick<typeof Atomics, "wait" | "notify"> = {
  wait: Atomics.wait,
  notify: Atomics.notify,
};

export function installAtomicsObservers(target: Pick<typeof Atomics, "wait" | "notify"> = Atomics): () => void {
  const wait = target.wait, notify = target.notify;
  target.wait = (array, index, value, timeout) => Reflect.apply(observedAtomics.wait, Atomics, [array, index, value, timeout]);
  target.notify = (array, index, count) => Reflect.apply(observedAtomics.notify, Atomics, [array, index, count]);
  return () => { target.wait = wait; target.notify = notify; };
}
