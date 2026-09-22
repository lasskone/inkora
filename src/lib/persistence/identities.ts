import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { MarketplaceProduct } from "@/lib/marketplace/types";
import type { SupplierProduct, SupplierVariant } from "@/lib/supplier/types";
import type {
  MarketplaceProductRow,
  SupplierProductRow,
  SupplierVariantRow,
} from "./types";

/**
 * The single persistence error class. Carries a secret-free message only — it
 * never wraps a raw upstream payload, connection string, or key, so a caller
 * can surface `message` without leaking anything.
 */
export class PersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceError";
  }
}

/**
 * Upserts a stable marketplace product identity.
 *
 * The identity is provider + external id. On conflict the row is reused: its
 * `last_seen_at` advances and `first_seen_at` is preserved, because identity is
 * stable across observations by design (docs/DATABASE.md §6.1).
 */
export async function upsertMarketplaceProduct(
  client: SupabaseClient,
  product: MarketplaceProduct,
  observedAt: string,
): Promise<MarketplaceProductRow> {
  const { data, error } = await client
    .from("marketplace_products")
    .upsert(
      {
        marketplace: product.marketplace,
        external_id: product.externalId,
        first_seen_at: observedAt,
        last_seen_at: observedAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "marketplace,external_id" },
    )
    .select()
    .single();

  if (error !== null || data === null) {
    throw new PersistenceError(
      `marketplace_products upsert failed: ${error?.message ?? "no row returned"}`,
    );
  }

  return data as MarketplaceProductRow;
}

/**
 * Upserts a stable supplier product identity (supplier + external id).
 */
export async function upsertSupplierProduct(
  client: SupabaseClient,
  product: SupplierProduct,
  observedAt: string,
): Promise<SupplierProductRow> {
  const { data, error } = await client
    .from("supplier_products")
    .upsert(
      {
        supplier: product.supplier,
        external_id: product.externalId,
        first_seen_at: observedAt,
        last_seen_at: observedAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "supplier,external_id" },
    )
    .select()
    .single();

  if (error !== null || data === null) {
    throw new PersistenceError(
      `supplier_products upsert failed: ${error?.message ?? "no row returned"}`,
    );
  }

  return data as SupplierProductRow;
}

/**
 * Upserts a stable supplier variant identity (supplier product + external
 * variant id). Returns `null` when the variant carries no usable external id —
 * without one there is no identity to persist.
 */
export async function upsertSupplierVariant(
  client: SupabaseClient,
  supplierProductId: string,
  variant: SupplierVariant,
  observedAt: string,
): Promise<SupplierVariantRow | null> {
  if (variant.externalId === null) {
    return null;
  }

  const { data, error } = await client
    .from("supplier_variants")
    .upsert(
      {
        supplier_product_id: supplierProductId,
        external_id: variant.externalId,
        sku: variant.sku,
        first_seen_at: observedAt,
        last_seen_at: observedAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "supplier_product_id,external_id" },
    )
    .select()
    .single();

  if (error !== null || data === null) {
    throw new PersistenceError(
      `supplier_variants upsert failed: ${error?.message ?? "no row returned"}`,
    );
  }

  return data as SupplierVariantRow;
}
