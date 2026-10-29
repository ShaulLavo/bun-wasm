import { Suspense } from "react";

export const dynamic = "force-dynamic";
async function Deferred() {
  await new Promise(resolve => setTimeout(resolve, 250));
  return <p>NEXT-01 deferred</p>;
}
export default function Page() {
  return <main><h1>NEXT-01 stream shell</h1><Suspense fallback={<p>NEXT-01 fallback</p>}><Deferred /></Suspense></main>;
}
