"use client";

import { useState } from "react";

export default function Home() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>Next.js App Router</h1>
      <p>Edit app/page.tsx. Next dev updates this preview when you save.</p>
      <button onClick={() => setCount(value => value + 1)}>Count: {count}</button>
    </main>
  );
}
