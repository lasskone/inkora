import type { Metadata } from "next";
import { Suspense } from "react";

import { ProductDetailPanel } from "./product-detail-panel";
import { decodeRouteItemId } from "@/lib/product-detail/product-detail-links";

export const metadata: Metadata = {
  title: "Product Detail — Inkora",
  description:
    "The opportunity intelligence Inkora has already computed for one marketplace listing.",
};

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  // The panel is a client component because it reads `useSearchParams` — the
  // replay query lives in the URL so a detail page is a stable, shareable link.
  // The boundary it talks to is the only place intelligence is derived.
  const { itemId: rawItemId } = await params;
  // A `[itemId]` segment reaches a page percent-encoded (eBay ids are composite
  // and `|` is reserved), so it is decoded at the edge and validated after —
  // never trusted to line up with the charset by accident.
  const itemId = decodeRouteItemId(rawItemId);
  return (
    <Suspense
      fallback={
        <div
          role="status"
          className="rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted"
        >
          Reading the persisted observations for this listing…
        </div>
      }
    >
      <ProductDetailPanel itemId={itemId} />
    </Suspense>
  );
}
