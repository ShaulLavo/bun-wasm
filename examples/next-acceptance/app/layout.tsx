import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export default function Layout({ children }: { children: ReactNode }) {
  return <html><body><nav><Link href="/">Home</Link> <Link href="/dynamic">Dynamic</Link> <Link href="/action">Action</Link></nav>{children}</body></html>;
}
