"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
}

export function Nav({ items }: { items: NavItem[] }) {
  const path = usePathname() ?? "/";
  return (
    <nav aria-label="Main" className="nav">
      {items.map((i) => {
        const here = path === i.href || path.startsWith(`${i.href}/`);
        return (
          <Link key={i.href} href={i.href} aria-current={here ? "page" : undefined}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
