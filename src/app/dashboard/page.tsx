import type { Metadata } from "next";
import { PagePlaceholder } from "@/components/page-placeholder";

export const metadata: Metadata = {
  title: "Dashboard — Inkora",
  description: "Prioritized opportunity overview and monitoring state.",
};

export default function DashboardPage() {
  return (
    <PagePlaceholder
      title="Dashboard"
      description="Prioritized opportunity overview, monitoring state, and entry points into the scanners."
    />
  );
}
