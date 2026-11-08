import { useState } from 'react';
import { useLoaderData, type LoaderFunctionArgs } from 'react-router';
export function loader({ request }: LoaderFunctionArgs) {
  return { value: new URL(request.url).searchParams.get('value') ?? 'initial' };
}
export default function Home() {
  const data = useLoaderData<typeof loader>();
  const [count, setCount] = useState(0);
  return <main><h1 id="message">Hello from react-router</h1><p id="server-value">{data.value}</p><button id="increment" onClick={() => setCount(count + 1)}>Increment</button><output id="count">{count}</output></main>;
}
