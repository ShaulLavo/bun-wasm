import { useEffect, useState } from "react";

export default function Home() {
  return (
    <main>
      <h1>Next.js in your browser</h1>
      <p>Edit pages/index.tsx. Next dev updates this preview when you save.</p>
      <Counter />
    </main>
  );
}

function Counter() {
  const [count, setCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);
  return <button disabled={!hydrated} onClick={() => setCount(value => value + 1)}>Count: {count}</button>;
}
