/**
 * Internal row and mapping types for the persistence layer.
 *
 * These describe the shapes that move between the repository layer and the
 * database. They are deliberately NOT exported outside `@/lib/persistence`: the
 * API boundary speaks the provider-independent normalized models and the
 * economics/matcher result types, never raw database rows.
 *
 * Money convention (docs/DATABASE.md §8): every monetary column is integer
 * minor units (cents), converted from and to the decimal-string contract of
 * the normalized models exclusively through `parseDecimalToCents` /
 * `formatCents`. Margin is "percent cents" (1/100 of one percent).
 */

import type { Provenance } from "@/lib/marketplace/types";

/** The database-side representation of the provenance enum. */
export type ProvenanceRow = Provenance;

/** Common identity-row shape shared by marketplace and supplier products. */
export interface ProductIdentityRow {
  id: string;
  first_seen_at: string;
  last_seen_at: string;
}

/** Marketplace `marketplace_products` identity row. */
export interface MarketplaceProductRow extends ProductIdentityRow {
  marketplace: string;
  external_id: string;
}

/** Supplier `supplier_products` identity row. */
export interface SupplierProductRow extends ProductIdentityRow {
  supplier: string;
  external_id: string;
}

/** Supplier `supplier_variants` identity row. */
export interface SupplierVariantRow extends ProductIdentityRow {
  supplier_product_id: string;
  external_id: string;
  sku: string | null;
}

/** `marketplace_product_snapshots` row. */
export interface MarketplaceSnapshotRow {
  id: string;
  marketplace_product_id: string;
  title: string;
  image_url: string | null;
  listing_url: string | null;
  price_cents: number | null;
  currency: string | null;
  condition: string | null;
  seller_identifier: string | null;
  seller_feedback_percentage: number | null;
  buyer_shipping_cents: number | null;
  shipping_currency: string | null;
  location: string | null;
  provenance: ProvenanceRow;
  content_hash: string;
  observed_at: string;
  ingested_at: string;
}

/** `supplier_product_snapshots` row. */
export interface SupplierSnapshotRow {
  id: string;
  supplier_product_id: string;
  title: string;
  image_url: string | null;
  product_url: string | null;
  category: string | null;
  catalog_reference_price_cents: number | null;
  currency: string | null;
  available_inventory: number | null;
  warehouse_country: string | null;
  shipping_origin: string | null;
  provenance: ProvenanceRow;
  content_hash: string;
  observed_at: string;
  ingested_at: string;
}

/** `supplier_variant_snapshots` row. */
export interface SupplierVariantSnapshotRow {
  id: string;
  supplier_variant_id: string;
  title: string | null;
  price_cents: number | null;
  currency: string | null;
  available_inventory: number | null;
  warehouse_countries: string[] | null;
  provenance: ProvenanceRow;
  content_hash: string;
  observed_at: string;
  ingested_at: string;
}

/** `match_observations` row. */
export interface MatchObservationRow {
  id: string;
  marketplace_product_id: string;
  marketplace_snapshot_id: string | null;
  supplier_product_id: string;
  supplier_snapshot_id: string | null;
  supplier_variant_id: string | null;
  matcher_version: string;
  confidence: number;
  confidence_band: "LOW" | "MEDIUM" | "HIGH";
  signals: unknown;
  contradictions: unknown;
  explanation: string | null;
  content_hash: string;
  calculated_at: string;
  ingested_at: string;
}

/** `economics_observations` row. */
export interface EconomicsObservationRow {
  id: string;
  marketplace_product_id: string;
  marketplace_snapshot_id: string | null;
  supplier_product_id: string;
  supplier_snapshot_id: string | null;
  supplier_variant_id: string | null;
  match_observation_id: string | null;
  item_price_cents: number | null;
  buyer_shipping_cents: number | null;
  gross_marketplace_revenue_cents: number | null;
  currency: string | null;
  supplier_product_cost_cents: number | null;
  supplier_cost_basis: string | null;
  supplier_shipping_cents: number | null;
  supplier_shipping_method: string | null;
  landed_cost_cents: number | null;
  marketplace_fee_cents: number | null;
  fee_engine_version: string;
  fee_rule_source: string;
  fee_breakdown: unknown;
  estimated_profit_cents: number | null;
  margin_percent_cents: number | null;
  completeness: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  shipping_quotes: unknown;
  shipping_destination: unknown;
  assumptions: unknown;
  warnings: unknown;
  provenance: unknown;
  content_hash: string;
  calculated_at: string;
  ingested_at: string;
}

/**
 * `opportunity_observations` row.
 *
 * `assessment` holds the complete `OpportunityAssessment` document; the summary
 * columns alongside it exist only so the common read paths (list this listing's
 * assessments, compare a score over time) never have to crack the JSON.
 */
export interface OpportunityObservationRow {
  id: string;
  marketplace_product_id: string;
  marketplace_snapshot_id: string | null;
  supplier_product_id: string | null;
  supplier_snapshot_id: string | null;
  supplier_variant_id: string | null;
  match_observation_id: string | null;
  economics_observation_id: string | null;
  engine_version: string;
  score: number;
  score_band: "LOW" | "MEDIUM" | "HIGH";
  confidence: number;
  confidence_level: "LOW" | "MEDIUM" | "HIGH";
  match_confidence: number;
  economics_completeness: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  competition_intensity: number;
  competition_verdict:
    | "INSUFFICIENT_EVIDENCE"
    | "APPEARS_LIMITED"
    | "APPEARS_MODERATE"
    | "APPEARS_BROAD";
  demand_verdict: "INSUFFICIENT_EVIDENCE" | "WEAKLY_SUPPORTING" | "SUPPORTING";
  competition_query: string | null;
  assessment: unknown;
  factors: unknown;
  caps: unknown;
  explanation: unknown;
  caveats: unknown;
  content_hash: string;
  calculated_at: string;
  ingested_at: string;
}

/**
 * Outcome of one observation write. The repository always reports whether it
 * inserted a new row or found an identical existing one, so the caller never
 * silently claims a new historical observation was created when it wasn't.
 */
export interface ObservationWriteResult<Row> {
  /** The row that now represents this observation. */
  row: Row;
  /** True when a new row was inserted; false when deduplication reused one. */
  inserted: boolean;
}
