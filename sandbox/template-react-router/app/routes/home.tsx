import { useEffect, useState } from 'react';
import { useLoaderData, type LoaderFunctionArgs } from 'react-router';
export function loader({ request }: LoaderFunctionArgs) {
  return { value: new URL(request.url).searchParams.get('value') ?? 'initial' };
}
export default function Home() {
  const data = useLoaderData<typeof loader>();
  const [count, setCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);
  return <main><h1 id="message">Hello from react-router</h1><p id="server-value">{data.value}</p><button id="increment" disabled={!hydrated} onClick={() => setCount(count + 1)}>Increment</button><output id="count">{count}</output></main>;
}
