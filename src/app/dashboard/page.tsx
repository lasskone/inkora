import type { Metadata } from "next";
import { Suspense } from "react";

import { DashboardPanel } from "./dashboard-panel";

export const metadata: Metadata = {
  title: "Dashboard — Inkora",
  description:
    "Prioritized opportunity overview, monitoring state and data coverage, from intelligence Inkora has already persisted.",
};

/**
 * The Dashboard page (docs/MVP_SPEC.md §4.1, docs/ARCHITECTURE.md §19).
 *
 * The panel is a client component because it reads `useSearchParams` — filters,
 * sort and page size live in the URL, so a Dashboard state is a shareable deep
 * link. The only intelligence boundary it talks to is `GET /api/dashboard`, and
 * that boundary reads persisted assessments without calling a marketplace,
 * supplier or freight API.
 */
export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-2 text-sm text-muted">
          An aggregation surface over assessments INKORA has already computed and
          persisted. Every figure is a stored observation with its own timestamp —
          nothing here is re-scored, re-matched or re-priced, and no figure is a
          live claim about a listing&#39;s present state.
        </p>
      </header>
      <Suspense
        fallback={
          <div
            role="status"
            className="rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted"
          >
            Reading the persisted intelligence for this Dashboard…
          </div>
        }
      >
        <DashboardPanel />
      </Suspense>
    </div>
  );
}

