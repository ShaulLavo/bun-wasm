import type { ReactNode } from "react";
import Link from "next/link";
import Hydration from "./hydration";
import "./globals.css";

export default function Layout({ children }: { children: ReactNode }) {
  return <html><body><Hydration /><nav><Link href="/">Home</Link> <Link href="/dynamic">Dynamic</Link> <Link href="/action">Action</Link></nav>{children}</body></html>;
}
