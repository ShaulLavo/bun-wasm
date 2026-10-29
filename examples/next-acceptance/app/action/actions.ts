"use server";
import { context } from "../context";

export async function submit(_previous: string, form: FormData) {
  await context(true);
  return "NEXT-01 action:" + String(form.get("value"));
}
