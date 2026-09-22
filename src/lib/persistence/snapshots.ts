import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { MarketplaceProduct } from "@/lib/marketplace/types";
import { marketplaceProductToSnapshotColumns } from "./mapping";
import { hashMarketplaceSnapshot } from "./content-hash";
import { findLatestObservation } from "./dedup";
import { PersistenceError } from "./identities";
import type {
  MarketplaceSnapshotRow,
  ObservationWriteResult,
} from "./types";

/**
 * Appends a marketplace observation, applying the deduplication policy:
 *
 *   insert a new snapshot only when its content hash differs from the most
 *   recent snapshot for this product; otherwise reuse that row unchanged.
 *
 * This keeps history complete (every real change is recorded) without growing
 * the table on identical repeated scans (docs/DATABASE.md §7).
 */
export async function appendMarketplaceSnapshot(
  client: SupabaseClient,
  marketplaceProductId: string,
  product: MarketplaceProduct,
): Promise<ObservationWriteResult<MarketplaceSnapshotRow>> {
  const columns = marketplaceProductToSnapshotColumns(product);
  const contentHash = hashMarketplaceSnapshot(columns);

  const existing = await findLatestObservation<MarketplaceSnapshotRow>(
    client,
    "marketplace_product_snapshots",
    {
      productColumn: "marketplace_product_id",
      productId: marketplaceProductId,
    },
  );

  if (existing !== null && existing.content_hash === contentHash) {
    return { row: existing, inserted: false };
  }

  const { data, error } = await client
    .from("marketplace_product_snapshots")
    .insert({
      marketplace_product_id: marketplaceProductId,
      title: columns.title,
      image_url: columns.imageUrl,
      listing_url: columns.listingUrl,
      price_cents: columns.priceCents,
      currency: columns.currency,
      condition: columns.condition,
      seller_identifier: columns.sellerIdentifier,
      seller_feedback_percentage: columns.sellerFeedbackPercentage,
      buyer_shipping_cents: columns.buyerShippingCents,
      shipping_currency: columns.shippingCurrency,
      location: columns.location,
      provenance: columns.provenance,
      content_hash: contentHash,
      observed_at: product.fetchedAt,
    })
    .select()
    .single();

  if (error !== null || data === null) {
    throw new PersistenceError(
      `marketplace_product_snapshots insert failed: ${error?.message ?? "no row returned"}`,
    );
  }

  return { row: data as MarketplaceSnapshotRow, inserted: true };
}
