import type { Metadata } from "next";
import { ProductScanner } from "./product-scanner";

export const metadata: Metadata = {
  title: "Product Scanner — Inkora",
  description: "Marketplace-side discovery of products and opportunities.",
};

export default function ProductsPage() {
  return <ProductScanner />;
}
