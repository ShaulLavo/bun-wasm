"use client";
import { useEffect, useState } from "react";

export default function Hydration() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return <span hidden data-next-ready={ready} />;
}
