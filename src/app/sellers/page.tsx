import type { Metadata } from "next";
import { PagePlaceholder } from "@/components/page-placeholder";

export const metadata: Metadata = {
  title: "Seller Scanner — Inkora",
  description: "Seller saturation, growth, and competitive behavior.",
};

export default function SellersPage() {
  return (
    <PagePlaceholder
      title="Seller Scanner"
      description="Competitive-side analysis: seller saturation, growth, and behavior."
    />
  );
}
