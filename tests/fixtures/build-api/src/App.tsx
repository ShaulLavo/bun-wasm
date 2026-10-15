import { useState } from "react";
import { label } from "./label";

function App() {
  const [n] = useState(0);
  return <p>{label(n)}</p>;
}

export default App;
