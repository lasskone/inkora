import type { Metadata } from "next";
import { PagePlaceholder } from "@/components/page-placeholder";

export const metadata: Metadata = {
  title: "Watchlist — Inkora",
  description: "Monitored products and opportunities tracked over time.",
};

export default function WatchlistPage() {
  return (
    <PagePlaceholder
      title="Watchlist"
      description="The monitored subset of products and opportunities the user wants tracked over time."
    />
  );
}
