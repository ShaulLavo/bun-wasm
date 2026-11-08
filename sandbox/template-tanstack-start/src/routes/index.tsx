import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
export const Route = createFileRoute('/')({
  loader: ({ location }) => ({ value: new URLSearchParams(location.searchStr).get('value') ?? 'initial' }),
  component: Home,
});
function Home() {
  const data = Route.useLoaderData();
  const [count, setCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);
  return <main><h1 id="message" data-hydrated={hydrated}>Hello from tanstack-start</h1><p id="server-value">{data.value}</p><button id="increment" disabled={!hydrated} onClick={() => setCount(count + 1)}>Increment</button><output id="count">{count}</output></main>;
}
