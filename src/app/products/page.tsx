import type { Metadata } from "next";
import { PagePlaceholder } from "@/components/page-placeholder";

export const metadata: Metadata = {
  title: "Product Scanner — Inkora",
  description: "Marketplace-side discovery of products and opportunities.",
};

export default function ProductsPage() {
  return (
    <PagePlaceholder
      title="Product Scanner"
      description="Marketplace-side discovery of products and opportunities by keyword, category, filters, and modes."
    />
  );
}
