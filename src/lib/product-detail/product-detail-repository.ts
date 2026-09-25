/**
 * Product Detail repository — the only server-only code path Product Detail
 * uses to read persisted intelligence (docs/ARCHITECTURE.md §13, §18).
 *
 * Deliberately *not* a domain service, exactly like the watchlist repository:
 * it stores and reads nothing of its own, maps rows to provider-identity read
 * models, and nothing else. It never scores, never matches, never prices.
 *
 * Conventions follow the persistence layer exactly (docs/DATABASE.md):
 *   - every function receives the client, so a test can inject a fake and no
 *     network is ever required;
 *   - reads are always bounded and most-recent-first;
 *   - a NULL `supplier_product_id` is a *scope* (`IS NULL`), never a value;
 *   - a read failure degrades to an empty list, so one failing section never
 *     blanks the page (docs/ARCHITECTURE.md §18.5).
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { MarketplaceId } from "@/lib/marketplace/types";
import type { OpportunityAssessment } from "@/lib/opportunity/types";
import {
  centsToDecimalOrNull,
  marketplaceSnapshotRowToReadModel,
  numericToNumber,
} from "@/lib/persistence/mapping";
import type {
  EconomicsObservationHistoryEntry,
  MarketplaceSnapshotHistoryEntry,
  MatchObservationHistoryEntry,
} from "@/types/product-history";
import type {
  ConfidenceBand,
  MatchContradiction,
  MatchSignal,
} from "@/lib/matcher/types";
import type {
  EconomicsCompleteness,
  EconomicsProvenance,
  FeeBreakdownComponent,
  ShippingDestination,
  SupplierCostBasis,
} from "@/lib/economics/types";
import type { ShippingQuote } from "@/lib/supplier/types";
import type { Provenance } from "@/lib/marketplace/types";

import type {
  LatestEconomicsRead,
  SupplierSnapshotRead,
} from "./read-model";

/** The only marketplace with an adapter today (docs/ARCHITECTURE.md §4). */
const MARKETPLACE: MarketplaceId = "ebay";

/** Scope narrowing: a NULL supplier is a scope, never a value. */
export interface ProductScope {
  marketplaceProductId: string;
  /** `null` selects the marketplace-only scope (`IS NULL`). */
  supplierProductId: string | null;
}

/** Stable marketplace identity lookup by provider + external id. */
export async function findMarketplaceProductId(
  client: SupabaseClient,
  externalId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("marketplace_products")
    .select("id")
    .eq("marketplace", MARKETPLACE)
    .eq("external_id", externalId)
    .limit(1);

  if (error !== null || data === null || data.length === 0) {
    return null;
  }
  return (data[0] as { id: string }).id;
}

/** Stable supplier identity lookup by external id. */
export async function findSupplierProductId(
  client: SupabaseClient,
  externalId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("supplier_products")
    .select("id")
    .eq("external_id", externalId)
    .limit(1);

  if (error !== null || data === null || data.length === 0) {
    return null;
  }
  return (data[0] as { id: string }).id;
}

/**
 * Bounded, most-recent-first marketplace snapshots for one listing.
 *
 * `[0]` is the latest observation and the array is the history series — one
 * bounded read serves both, which is how Product Detail keeps its read budget
 * small (docs/ARCHITECTURE.md §18.7).
 */
export async function readMarketplaceSnapshots(
  client: SupabaseClient,
  marketplaceProductId: string,
  limit: number,
): Promise<MarketplaceSnapshotHistoryEntry[]> {
  const { data, error } = await client
    .from("marketplace_product_snapshots")
    .select("*")
    .eq("marketplace_product_id", marketplaceProductId)
    .order("observed_at", { ascending: false })
    .limit(limit);

  if (error !== null || data === null) {
    return [];
  }
  return (data as unknown[]).map((row) =>
    marketplaceSnapshotRowToReadModel(row as Parameters<typeof marketplaceSnapshotRowToReadModel>[0]),
  );
}


/** Shape of the joined match-observation read, with the matcher's reasoning. */
interface MatchDetailRow {
  supplier_product_id: string;
  supplier_products:
    | { external_id: string | null }
    | { external_id: string | null }[]
    | null;
  matcher_version: string;
  confidence: number | string | null;
  confidence_band: ConfidenceBand;
  explanation: string | null;
  signals: MatchSignal[] | null;
  contradictions: MatchContradiction[] | null;
  calculated_at: string;
}

/** Accepts both PostgREST to-one join spellings (see history-reader.ts). */
function joinedExternalId(
  joined: { external_id: string | null } | { external_id: string | null }[] | null,
): string | null {
  if (joined === null) {
    return null;
  }
  if (Array.isArray(joined)) {
    return joined[0]?.external_id ?? null;
  }
  return joined.external_id;
}

/**
 * Bounded match observations, newest first, carrying the matcher's own
 * signals and contradictions — the history read deliberately omits those, so
 * Product Detail selects them for its match section.
 */
export async function readMatchObservations(
  client: SupabaseClient,
  scope: ProductScope,
  limit: number,
): Promise<MatchObservationHistoryEntry[]> {
  if (scope.supplierProductId === null) {
    // A match observation always belongs to a supplier; the marketplace-only
    // scope has none, so the honest answer is an empty series.
    return [];
  }

  const { data, error } = await client
    .from("match_observations")
    .select(
      "supplier_product_id, supplier_products(external_id), matcher_version, confidence, confidence_band, calculated_at",
    )
    .eq("marketplace_product_id", scope.marketplaceProductId)
    .eq("supplier_product_id", scope.supplierProductId)
    .order("calculated_at", { ascending: false })
    .limit(limit);

  if (error !== null || data === null) {
    return [];
  }

  return (data as MatchDetailRow[]).map((row) => ({
    supplierProductId: row.supplier_product_id,
    supplierExternalId: joinedExternalId(row.supplier_products),
    matcherVersion: row.matcher_version,
    confidence: numericToNumber(row.confidence) ?? 0,
    confidenceBand: row.confidence_band,
    calculatedAt: row.calculated_at,
  }));
}

/**
 * The latest match observation with the matcher's full reasoning — signals,
 * contradictions and its own explanation — so the match section can show
 * *why* a confidence is what it is.
 */
export async function readLatestMatchDetail(
  client: SupabaseClient,
  scope: ProductScope,
): Promise<{
  matcherVersion: string | null;
  confidence: number | null;
  confidenceBand: ConfidenceBand | null;
  explanation: string | null;
  signals: MatchSignal[];
  contradictions: MatchContradiction[];
} | null> {
  if (scope.supplierProductId === null) {
    return null;
  }

  const { data, error } = await client
    .from("match_observations")
    .select(
      "matcher_version, confidence, confidence_band, explanation, signals, contradictions",
    )
    .eq("marketplace_product_id", scope.marketplaceProductId)
    .eq("supplier_product_id", scope.supplierProductId)
    .order("calculated_at", { ascending: false })
    .limit(1);

  if (error !== null || data === null || data.length === 0) {
    return null;
  }

  const row = data[0] as MatchDetailRow;
  return {
    matcherVersion: row.matcher_version,
    confidence: numericToNumber(row.confidence),
    confidenceBand: row.confidence_band,
    explanation: row.explanation,
    signals: row.signals ?? [],
    contradictions: row.contradictions ?? [],
  };
}


/** Shape of the bounded economics history read for one scope. */
interface EconomicsSummaryRow {
  supplier_product_id: string;
  supplier_products:
    | { external_id: string | null }
    | { external_id: string | null }[]
    | null;
  item_price_cents: number | string | null;
  supplier_product_cost_cents: number | string | null;
  supplier_cost_basis: SupplierCostBasis | null;
  landed_cost_cents: number | string | null;
  marketplace_fee_cents: number | string | null;
  estimated_profit_cents: number | string | null;
  margin_percent_cents: number | string | null;
  completeness: EconomicsCompleteness;
  fee_engine_version: string;
  calculated_at: string;
}

/** Stored percent-cents become a percentage string again (e.g. `3699` → `36.99`). */
function percentCentsToMargin(percentCents: number | null): string | null {
  if (percentCents === null) {
    return null;
  }
  return (percentCents / 100).toString();
}

/** Bounded economics observations for one scope, newest first. */
export async function readEconomicsSummary(
  client: SupabaseClient,
  scope: ProductScope,
  limit: number,
): Promise<EconomicsObservationHistoryEntry[]> {
  if (scope.supplierProductId === null) {
    return [];
  }

  const { data, error } = await client
    .from("economics_observations")
    .select(
      "supplier_product_id, supplier_products(external_id), item_price_cents, supplier_product_cost_cents, supplier_cost_basis, landed_cost_cents, marketplace_fee_cents, estimated_profit_cents, margin_percent_cents, completeness, fee_engine_version, calculated_at",
    )
    .eq("marketplace_product_id", scope.marketplaceProductId)
    .eq("supplier_product_id", scope.supplierProductId)
    .order("calculated_at", { ascending: false })
    .limit(limit);

  if (error !== null || data === null) {
    return [];
  }

  return (data as EconomicsSummaryRow[]).map((row) => ({
    supplierProductId: row.supplier_product_id,
    supplierExternalId: joinedExternalId(row.supplier_products),
    itemPrice: centsToDecimalOrNull(numericToNumber(row.item_price_cents)),
    supplierProductCost: centsToDecimalOrNull(
      numericToNumber(row.supplier_product_cost_cents),
    ),
    supplierCostBasis: row.supplier_cost_basis,
    landedCost: centsToDecimalOrNull(numericToNumber(row.landed_cost_cents)),
    marketplaceFee: centsToDecimalOrNull(numericToNumber(row.marketplace_fee_cents)),
    estimatedProfit: centsToDecimalOrNull(numericToNumber(row.estimated_profit_cents)),
    marginPercent: percentCentsToMargin(numericToNumber(row.margin_percent_cents)),
    completeness: row.completeness,
    feeEngineVersion: row.fee_engine_version,
    calculatedAt: row.calculated_at,
  }));
}


/** Shape of the full latest-economics read. */
interface FullEconomicsRow {
  calculated_at: string;
  item_price_cents: number | string | null;
  buyer_shipping_cents: number | string | null;
  gross_marketplace_revenue_cents: number | string | null;
  currency: string | null;
  supplier_product_cost_cents: number | string | null;
  supplier_cost_basis: SupplierCostBasis | null;
  supplier_shipping_cents: number | string | null;
  supplier_shipping_method: string | null;
  landed_cost_cents: number | string | null;
  marketplace_fee_cents: number | string | null;
  fee_engine_version: string;
  fee_rule_source: string;
  fee_breakdown: FeeBreakdownComponent[] | null;
  estimated_profit_cents: number | string | null;
  margin_percent_cents: number | string | null;
  completeness: EconomicsCompleteness;
  shipping_quotes: ShippingQuote[] | null;
  shipping_destination: ShippingDestination | null;
  assumptions: string[] | null;
  warnings: string[] | null;
  provenance: EconomicsProvenanceRow | null;
}

/** Per-component provenance as stored in the JSON column. */
type EconomicsProvenanceRow = EconomicsProvenance;

/**
 * The latest economics observation for one scope, with its full breakdown,
 * every quote, the stated assumptions and the per-component provenance.
 */
export async function readLatestEconomics(
  client: SupabaseClient,
  scope: ProductScope,
): Promise<LatestEconomicsRead | null> {
  if (scope.supplierProductId === null) {
    return null;
  }

  const { data, error } = await client
    .from("economics_observations")
    .select(
      "calculated_at, item_price_cents, buyer_shipping_cents, gross_marketplace_revenue_cents, currency, supplier_product_cost_cents, supplier_cost_basis, supplier_shipping_cents, supplier_shipping_method, landed_cost_cents, marketplace_fee_cents, fee_engine_version, fee_rule_source, fee_breakdown, estimated_profit_cents, margin_percent_cents, completeness, shipping_quotes, shipping_destination, assumptions, warnings, provenance",
    )
    .eq("marketplace_product_id", scope.marketplaceProductId)
    .eq("supplier_product_id", scope.supplierProductId)
    .order("calculated_at", { ascending: false })
    .limit(1);

  if (error !== null || data === null || data.length === 0) {
    return null;
  }

  return mapFullEconomics(data[0] as FullEconomicsRow);
}

/** Maps one full economics row back to the money contract. Pure on purpose. */
export function mapFullEconomics(row: FullEconomicsRow): LatestEconomicsRead {
  return {
    calculatedAt: row.calculated_at,
    itemPrice: centsToDecimalOrNull(numericToNumber(row.item_price_cents)),
    buyerShipping: centsToDecimalOrNull(numericToNumber(row.buyer_shipping_cents)),
    grossMarketplaceRevenue: centsToDecimalOrNull(
      numericToNumber(row.gross_marketplace_revenue_cents),
    ),
    currency: row.currency,
    supplierProductCost: centsToDecimalOrNull(
      numericToNumber(row.supplier_product_cost_cents),
    ),
    supplierCostBasis: row.supplier_cost_basis,
    supplierShippingCost: centsToDecimalOrNull(
      numericToNumber(row.supplier_shipping_cents),
    ),
    supplierShippingMethod: row.supplier_shipping_method,
    // Not persisted as a column (docs/DATABASE.md §6.7).
    supplierShippingTransitTime: null,
    shippingQuotes: row.shipping_quotes ?? [],
    shippingDestination: row.shipping_destination,
    landedSupplierCost: centsToDecimalOrNull(numericToNumber(row.landed_cost_cents)),
    marketplaceFee: centsToDecimalOrNull(numericToNumber(row.marketplace_fee_cents)),
    feeBreakdown: row.fee_breakdown ?? [],
    feeEngineVersion: row.fee_engine_version,
    feeRuleSource: row.fee_rule_source,
    estimatedProfit: centsToDecimalOrNull(numericToNumber(row.estimated_profit_cents)),
    marginPercent: percentCentsToMargin(numericToNumber(row.margin_percent_cents)),
    completeness: row.completeness,
    // Not persisted as a column; the fee-rule version is.
    economicsEngineVersion: null,
    assumptions: row.assumptions ?? [],
    warnings: row.warnings ?? [],
    provenance: row.provenance,
  };
}


/** Shape of the supplier-product read for the supplier section. */
interface SupplierProductRow {
  id: string;
  external_id: string;
  title: string | null;
  image_url: string | null;
  product_url: string | null;
  category: string | null;
  reference_cost_cents: number | string | null;
  currency: string | null;
  available_inventory: number | string | null;
  warehouse_country: string | null;
  shipping_origin_country: string | null;
  provenance: Provenance | null;
  last_observed_at: string | null;
}

/** Persisted observations of the supplier product in scope, newest first. */
export async function readSupplierProducts(
  client: SupabaseClient,
  supplierProductId: string,
): Promise<SupplierSnapshotRead[]> {
  const { data, error } = await client
    .from("supplier_products")
    .select(
      "id, external_id, title, image_url, product_url, category, reference_cost_cents, currency, available_inventory, warehouse_country, shipping_origin_country, provenance, last_observed_at",
    )
    .eq("id", supplierProductId)
    .limit(1);

  if (error !== null || data === null || data.length === 0) {
    return [];
  }

  const row = data[0] as SupplierProductRow;
  return [
    {
      title: row.title,
      imageUrl: row.image_url,
      productUrl: row.product_url,
      category: row.category,
      referenceCost: centsToDecimalOrNull(numericToNumber(row.reference_cost_cents)),
      currency: row.currency,
      availableInventory: numericToNumber(row.available_inventory),
      warehouseCountry: row.warehouse_country,
      shippingOrigin: row.shipping_origin_country,
      provenance: row.provenance ?? "OBSERVED",
      observedAt: row.last_observed_at ?? new Date(0).toISOString(),
    },
  ];
}

/**
 * Bounded prior assessments for one scope, newest first, with their metadata —
 * the opportunity half of the history series.
 *
 * Reads the same `opportunity_observations` table the Opportunity Engine
 * appends to and the Watchlist reads from (docs/DATABASE.md §6.8), so this page
 * can never disagree with either about what was assessed. A NULL supplier is a
 * *scope* (`IS NULL`): an assessment recorded with no matcher candidate is a
 * legitimate verdict for the marketplace-only scope and must still surface here.
 */
export async function readAssessmentHistory(
  client: SupabaseClient,
  scope: ProductScope,
  limit: number,
): Promise<OpportunityAssessment[]> {
  let query = client
    .from("opportunity_observations")
    .select("assessment")
    .eq("marketplace_product_id", scope.marketplaceProductId)
    .order("calculated_at", { ascending: false })
    .limit(limit);

  query =
    scope.supplierProductId === null
      ? query.is("supplier_product_id", null)
      : query.eq("supplier_product_id", scope.supplierProductId);

  const { data, error } = await query;
  if (error !== null || data === null) {
    return [];
  }

  return (data as { assessment: OpportunityAssessment | null }[])
    .map((row) => row.assessment)
    .filter((document): document is OpportunityAssessment => document !== null && typeof document === "object");
}

/**
 * The replay query that originally surfaced this listing.
 *
 * Used only to re-resolve the *same* item on a refresh, never to re-run a
 * broad search, and never interpolated into an upstream URL — the id resolved
 * is compared to the id requested (docs/ARCHITECTURE.md §8.3).
 */
export async function readReplayQuery(
  client: SupabaseClient,
  marketplaceProductId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("marketplace_products")
    .select("search_query")
    .eq("id", marketplaceProductId)
    .limit(1);

  if (error !== null || data === null || data.length === 0) {
    return null;
  }
  return (data[0] as { search_query: string | null }).search_query;
}
