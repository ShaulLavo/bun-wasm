"use client";
export default function ErrorPage({ reset }: { reset(): void }) {
  return <main><h1>NEXT-01 application error</h1><button onClick={reset}>Retry</button></main>;
}
