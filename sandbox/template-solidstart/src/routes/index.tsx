import { createSignal } from 'solid-js';
import { useLocation } from '@solidjs/router';
export default function Home() {
  const location = useLocation();
  const [count, setCount] = createSignal(0);
  const value = () => new URLSearchParams(location.search).get('value') ?? 'initial';
  return <main><h1 id="message">Hello from solidstart</h1><p id="server-value">{value()}</p><button id="increment" onClick={() => setCount(count() + 1)}>Increment</button><output id="count">{count()}</output></main>;
}
