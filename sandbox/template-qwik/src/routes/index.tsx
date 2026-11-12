import { component$, useSignal } from "@builder.io/qwik";
export default component$(() => {
  const count = useSignal(0);
  return <main><h1 id="message">Hello from qwik</h1><button id="increment" onClick$={() => count.value++}>Increment</button><output id="count">{count.value}</output></main>;
});
