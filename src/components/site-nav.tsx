"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/products", label: "Product Scanner" },
  { href: "/suppliers", label: "Supplier Scanner" },
  { href: "/sellers", label: "Seller Scanner" },
  { href: "/watchlist", label: "Watchlist" },
] as const;

export function SiteNav() {
  const pathname = usePathname();

  return (
    <header className="border-b border-border bg-surface">
      <div className="w-full max-w-5xl mx-auto px-6 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Link
          href="/"
          className="text-lg font-semibold tracking-tight"
          aria-label="Inkora home"
        >
          INKORA
        </Link>
        <nav aria-label="Primary">
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {NAV_ITEMS.map((item) => {
              const isActive =
                pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={
                      isActive
                        ? "font-medium text-foreground"
                        : "text-muted hover:text-foreground"
                    }
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </header>
  );
}
