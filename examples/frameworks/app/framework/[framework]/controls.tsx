"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { frameworks, type Framework } from "../../../names";

export default function Controls({ framework }: { framework: Framework }) {
  const router = useRouter();
  const [clicks, setClicks] = useState(0);
  const [status, setStatus] = useState("");
  async function add(data: FormData) {
    const response = await fetch(`../api/${framework}/items`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: data.get("text") }),
    });
    setStatus(`POST ${response.status}`);
    if (response.ok) router.refresh();
  }
  return <section>
    <button onClick={() => setClicks(value => value + 1)}>Client clicks: {clicks}</button>
    <form action={add}><label>Note <input name="text" required /></label><button>Add note</button></form>
    <p role="status">{status}</p>
    <nav>{frameworks.map(name => <Link key={name} href={`../framework/${name}`}>{name} </Link>)}</nav>
    <a href="../probe.txt">Public asset</a>
  </section>;
}
