import type { Metadata } from "next";
import { OpportunityScanner } from "./opportunity-scanner";
import { ProductScanner } from "./product-scanner";

export const metadata: Metadata = {
  title: "Product Scanner — Inkora",
  description: "Marketplace-side discovery of products and opportunities.",
};

export default function ProductsPage() {
  return (
    <div className="flex flex-col gap-12">
      <OpportunityScanner />
      <div className="border-t border-border" />
      <ProductScanner />
    </div>
  );
}
