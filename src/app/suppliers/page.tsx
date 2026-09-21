import type { Metadata } from "next";

import { SupplierScanner } from "./supplier-scanner";

export const metadata: Metadata = {
  title: "Supplier Scanner — Inkora",
  description:
    "Supplier-side discovery: normalized CJdropshipping catalogue results.",
};

export default function SuppliersPage() {
  return <SupplierScanner />;
}
