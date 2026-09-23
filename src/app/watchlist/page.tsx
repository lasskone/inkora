import type { Metadata } from "next";

import { WatchlistPanel } from "./watchlist-panel";

export const metadata: Metadata = {
  title: "Watchlist — Inkora",
  description: "Monitored products and opportunities tracked over time.",
};

export default function WatchlistPage() {
  return (
    <div className="flex flex-col gap-12">
      <WatchlistPanel />
    </div>
  );
}
