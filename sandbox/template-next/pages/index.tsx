import { useState } from "react";

export default function Home() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>Next.js in your browser</h1>
      <p>Edit pages/index.tsx. Next dev updates this preview when you save.</p>
      <button onClick={() => setCount(value => value + 1)}>Count: {count}</button>
    </main>
  );
}
