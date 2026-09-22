import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { EconomicsResult } from "@/lib/economics/types";
import { toCentsOrNull, marginPercentToPercentCents } from "./mapping";
import { hashEconomicsObservation } from "./content-hash";
import { findLatestObservation } from "./dedup";
import { PersistenceError } from "./identities";
import type {
  EconomicsObservationRow,
  ObservationWriteResult,
} from "./types";

/**
 * Appends an economics observation: every monetary component, the cost basis,
 * the fee-engine version, and all caveats — never just profit/margin
 * (docs/DATABASE.md §6.7).
 *
 * Profit may legitimately be negative and is stored as-is; the column carries no
 * non-negativity constraint by design. Deduplication reuses the latest
 * observation when nothing meaningful changed, and the fee-engine version is
 * part of the hash on purpose: the same inputs under a new fee-rule version are
 * a *different* calculation and must be recorded separately.
 */
export async function appendEconomicsObservation(
  client: SupabaseClient,
  params: {
    marketplaceProductId: string;
    marketplaceSnapshotId: string;
    supplierProductId: string;
    supplierSnapshotId: string;
    supplierVariantId: string | null;
    matchObservationId: string;
    economics: EconomicsResult;
  },
): Promise<ObservationWriteResult<EconomicsObservationRow>> {
  const economics = params.economics;
  const marginPercentCents = marginPercentToPercentCents(economics.marginPercent);
  const contentHash = hashEconomicsObservation({
    feeEngineVersion: economics.feeEngineVersion,
    economicsEngineVersion: economics.economicsEngineVersion,
    completeness: economics.completeness,
    itemPriceCents: toCentsOrNull(economics.itemPrice),
    buyerShippingCents: toCentsOrNull(economics.buyerShipping),
    grossMarketplaceRevenueCents: toCentsOrNull(economics.grossMarketplaceRevenue),
    currency: economics.currency,
    supplierProductCostCents: toCentsOrNull(economics.supplierProductCost),
    supplierCostBasis: economics.supplierCostBasis,
    supplierShippingCents: toCentsOrNull(economics.supplierShippingCost),
    supplierShippingMethod: economics.supplierShippingMethod,
    landedCostCents: toCentsOrNull(economics.landedSupplierCost),
    marketplaceFeeCents: toCentsOrNull(economics.marketplaceFee),
    estimatedProfitCents: toCentsOrNull(economics.estimatedProfit),
    marginPercentCents,
    shippingDestination: economics.shippingDestination,
  });

  const existing = await findLatestObservation<EconomicsObservationRow>(
    client,
    "economics_observations",
    {
      productColumn: "marketplace_product_id",
      productId: params.marketplaceProductId,
      supplierProductId: params.supplierProductId,
    },
  );

  if (existing !== null && existing.content_hash === contentHash) {
    return { row: existing, inserted: false };
  }

  const { data, error } = await client
    .from("economics_observations")
    .insert({
      marketplace_product_id: params.marketplaceProductId,
      marketplace_snapshot_id: params.marketplaceSnapshotId,
      supplier_product_id: params.supplierProductId,
      supplier_snapshot_id: params.supplierSnapshotId,
      supplier_variant_id: params.supplierVariantId,
      match_observation_id: params.matchObservationId,
      item_price_cents: toCentsOrNull(economics.itemPrice),
      buyer_shipping_cents: toCentsOrNull(economics.buyerShipping),
      gross_marketplace_revenue_cents: toCentsOrNull(economics.grossMarketplaceRevenue),
      currency: economics.currency,
      supplier_product_cost_cents: toCentsOrNull(economics.supplierProductCost),
      supplier_cost_basis: economics.supplierCostBasis,
      supplier_shipping_cents: toCentsOrNull(economics.supplierShippingCost),
      supplier_shipping_method: economics.supplierShippingMethod,
      landed_cost_cents: toCentsOrNull(economics.landedSupplierCost),
      marketplace_fee_cents: toCentsOrNull(economics.marketplaceFee),
      fee_engine_version: economics.feeEngineVersion,
      fee_rule_source: economics.feeRuleSource,
      fee_breakdown: economics.feeBreakdown,
      estimated_profit_cents: toCentsOrNull(economics.estimatedProfit),
      margin_percent_cents: marginPercentCents,
      completeness: economics.completeness,
      shipping_quotes: economics.shippingQuotes,
      shipping_destination: economics.shippingDestination,
      assumptions: economics.assumptions,
      warnings: economics.warnings,
      provenance: economics.provenance,
      content_hash: contentHash,
      calculated_at: economics.calculatedAt,
    })
    .select()
    .single();

  if (error !== null || data === null) {
    throw new PersistenceError(
      `economics_observations insert failed: ${error?.message ?? "no row returned"}`,
    );
  }

  return { row: data as EconomicsObservationRow, inserted: true };
}
