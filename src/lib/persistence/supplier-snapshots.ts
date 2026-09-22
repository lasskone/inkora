import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SupplierProduct, SupplierVariant } from "@/lib/supplier/types";
import {
  supplierProductToSnapshotColumns,
  supplierVariantToSnapshotColumns,
} from "./mapping";
import {
  hashSupplierSnapshot,
  hashSupplierVariantSnapshot,
} from "./content-hash";
import { findLatestObservation } from "./dedup";
import { PersistenceError } from "./identities";
import type {
  ObservationWriteResult,
  SupplierSnapshotRow,
  SupplierVariantSnapshotRow,
} from "./types";

/**
 * Appends a supplier product observation under the deduplication policy: insert
 * only when the content hash differs from the most recent observation for this
 * product, otherwise reuse that row (docs/DATABASE.md §7).
 */
export async function appendSupplierSnapshot(
  client: SupabaseClient,
  supplierProductId: string,
  product: SupplierProduct,
): Promise<ObservationWriteResult<SupplierSnapshotRow>> {
  const columns = supplierProductToSnapshotColumns(product);
  const contentHash = hashSupplierSnapshot(columns);

  const existing = await findLatestObservation<SupplierSnapshotRow>(
    client,
    "supplier_product_snapshots",
    {
      productColumn: "supplier_product_id",
      productId: supplierProductId,
    },
  );

  if (existing !== null && existing.content_hash === contentHash) {
    return { row: existing, inserted: false };
  }

  const { data, error } = await client
    .from("supplier_product_snapshots")
    .insert({
      supplier_product_id: supplierProductId,
      title: columns.title,
      image_url: columns.imageUrl,
      product_url: columns.productUrl,
      category: columns.category,
      catalog_reference_price_cents: columns.catalogReferencePriceCents,
      currency: columns.currency,
      available_inventory: columns.availableInventory,
      warehouse_country: columns.warehouseCountry,
      shipping_origin: columns.shippingOrigin,
      provenance: columns.provenance,
      content_hash: contentHash,
      observed_at: product.fetchedAt,
    })
    .select()
    .single();

  if (error !== null || data === null) {
    throw new PersistenceError(
      `supplier_product_snapshots insert failed: ${error?.message ?? "no row returned"}`,
    );
  }

  return { row: data as SupplierSnapshotRow, inserted: true };
}

/**
 * Appends a supplier variant observation under the same policy. Inventory is
 * highly time-sensitive: the row is append-only and always carries its own
 * observation time, so a historical quantity is never current stock
 * (docs/DATABASE.md §6.5).
 */
export async function appendSupplierVariantSnapshot(
  client: SupabaseClient,
  supplierVariantId: string,
  variant: SupplierVariant,
  observedAt: string,
): Promise<ObservationWriteResult<SupplierVariantSnapshotRow>> {
  const columns = supplierVariantToSnapshotColumns(variant);
  const contentHash = hashSupplierVariantSnapshot(columns);

  const existing = await findLatestObservation<SupplierVariantSnapshotRow>(
    client,
    "supplier_variant_snapshots",
    {
      productColumn: "supplier_variant_id",
      productId: supplierVariantId,
    },
  );

  if (existing !== null && existing.content_hash === contentHash) {
    return { row: existing, inserted: false };
  }

  const { data, error } = await client
    .from("supplier_variant_snapshots")
    .insert({
      supplier_variant_id: supplierVariantId,
      title: columns.title,
      price_cents: columns.priceCents,
      currency: columns.currency,
      available_inventory: columns.availableInventory,
      warehouse_countries: columns.warehouseCountries,
      provenance: columns.provenance,
      content_hash: contentHash,
      observed_at: observedAt,
    })
    .select()
    .single();

  if (error !== null || data === null) {
    throw new PersistenceError(
      `supplier_variant_snapshots insert failed: ${error?.message ?? "no row returned"}`,
    );
  }

  return { row: data as SupplierVariantSnapshotRow, inserted: true };
}
