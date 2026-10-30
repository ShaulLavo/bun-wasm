import { useState } from "react";
import "./App.css";

function App() {
  const [count, setCount] = useState(0);

  return (
    <main className="app">
      <h1>Hello from bun.wasm</h1>
      <p className="tagline">Vite serves this React app through Bun, running in your browser.</p>
      <button className="counter" onClick={() => setCount((n) => n + 1)}>
        count is {count}
      </button>
      <p className="hint">
        Edit <code>src/App.tsx</code> and the page updates without losing the count.
      </p>
    </main>
  );
}

export default App;
