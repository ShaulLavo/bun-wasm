"use client";
import { useEffect, useState } from "react";

export default function Client() {
  const [count, setCount] = useState(0);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return <section data-hydrated={ready}><p data-client-edit>client-original</p><button disabled={!ready} onClick={() => setCount(count + 1)}>Count: {count}</button></section>;
}
