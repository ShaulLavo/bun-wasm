"use client";
import { useActionState, useEffect, useState } from "react";
import { submit } from "./actions";

export default function Form() {
  const [value, action, pending] = useActionState(submit, "");
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return <form action={action} data-hydrated={ready}><input name="value" defaultValue="submitted" /><button disabled={pending || !ready}>Submit action</button><output data-action-result>{value}</output></form>;
}
