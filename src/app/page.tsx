import Link from "next/link";

const PRIMARY_AREAS = [
  {
    href: "/dashboard",
    label: "Dashboard",
    description:
      "Prioritized opportunity overview, monitoring state, and entry points into the scanners.",
  },
  {
    href: "/products",
    label: "Product Scanner",
    description:
      "Marketplace-side discovery of products and opportunities by keyword, category, and filters.",
  },
  {
    href: "/sellers",
    label: "Seller Scanner",
    description:
      "Competitive-side analysis: seller saturation, growth, and behavior.",
  },
  {
    href: "/watchlist",
    label: "Watchlist",
    description:
      "The monitored subset of products and opportunities tracked over time.",
  },
] as const;

export default function Home() {
  return (
    <div className="flex flex-col gap-12">
      <section className="flex flex-col gap-5">
        <p className="text-sm font-medium text-muted">
          Cross-Marketplace E-Commerce Opportunity Intelligence
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">INKORA</h1>
        <p className="text-lg leading-relaxed text-muted max-w-2xl">
          Inkora identifies which products are selling, where they are selling,
          how competitive the market is, where they can be sourced, and which
          Marketplace × Supplier combination provides the strongest business
          opportunity.
        </p>
        <p className="text-sm text-muted max-w-2xl">
          MVP V1 focus: eBay marketplace discovery, matched against CJdropshipping
          supply.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Primary areas</h2>
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {PRIMARY_AREAS.map((area) => (
            <li
              key={area.href}
              className="flex flex-col gap-2 border border-border rounded-lg bg-surface p-5"
            >
              <Link href={area.href} className="font-medium hover:underline">
                {area.label}
              </Link>
              <p className="text-sm text-muted">{area.description}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
