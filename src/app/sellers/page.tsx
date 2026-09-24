import type { Metadata } from "next";

import { SellerScanner } from "./seller-scanner";

export const metadata: Metadata = {
  title: "Seller Scanner — Inkora",
  description: "Seller saturation, growth, and competitive behavior.",
};

export default function SellersPage() {
  return <SellerScanner />;
}
