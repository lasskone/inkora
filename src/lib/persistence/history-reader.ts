import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createPersistenceClient } from "./client";
import {
  clampLimit,
  centsToDecimalOrNull,
  DEFAULT_HISTORY_LIMIT,
  marketplaceSnapshotRowToReadModel,
  MAX_HISTORY_LIMIT,
  numericToNumber,
  percentCentsToMarginPercent,
} from "./mapping";
import type {
  EconomicsObservationRow,
  MarketplaceProductRow,
  MarketplaceSnapshotRow,
  MatchObservationRow,
} from "./types";
import type {
  EconomicsObservationHistoryEntry,
  ProductHistory,
} from "@/types/product-history";

// The read bounds live in the pure mapping module so the contract is
// unit-testable without a database; re-exported for the route boundary.
export { clampLimit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT };

/**
 * Read outcome. `disabled` means persistence is not configured; `not_found`
 * means no persisted identity exists for that provider id yet.
 */
export type HistoryReadResult =
  | { status: "ok"; history: ProductHistory }
  | { status: "disabled" }
  | { status: "not_found" }
  | { status: "error"; message: string };

/**
 * Reads the supplier external id from a `supplier_products!inner(external_id)`
 * join.
 *
 * PostgREST embeds a to-one relationship as an *object*, but its shape is not
 * worth trusting blindly across PostgREST versions, so both the object and the
 * array spellings are accepted. The value is `null` only when it is genuinely
 * absent, never because the join shape surprised us.
 */
function joinedSupplierExternalId(
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

/** Shape of the joined match-observation read. */
interface MatchHistoryJoinRow {
  supplier_product_id: string;
  supplier_products:
    | { external_id: string | null }
    | { external_id: string | null }[]
    | null;
  matcher_version: string;
  confidence: number | string | null;
  confidence_band: MatchObservationRow["confidence_band"];
  calculated_at: string;
}

/** Shape of the joined economics-observation read. */
interface EconomicsHistoryJoinRow {
  supplier_product_id: string;
  supplier_products:
    | { external_id: string | null }
    | { external_id: string | null }[]
    | null;
  item_price_cents: number | string | null;
  supplier_product_cost_cents: number | string | null;
  supplier_cost_basis: string | null;
  landed_cost_cents: number | string | null;
  marketplace_fee_cents: number | string | null;
  estimated_profit_cents: number | string | null;
  margin_percent_cents: number | string | null;
  completeness: EconomicsObservationRow["completeness"];
  fee_engine_version: string;
  calculated_at: string;
}

/**
 * Reads the bounded, chronological history for one marketplace listing.
 *
 *   GET /api/products/history?itemId=<ebayItemId>&limit=<n>
 *
 * The lookup is provider + external id — the same stable identity the write
 * path anchored to — so a title change never orphans a product's history. All
 * reads are bounded and ordered most-recent-first; the caller never receives an
 * unbounded cursor, and every row carries its own observation timestamp.
 */
export async function readMarketplaceProductHistory(params: {
  marketplace: string;
  externalId: string;
  limit?: number;
}): Promise<HistoryReadResult> {
  const client = createPersistenceClient();
  if (client === null) {
    return { status: "disabled" };
  }

  const limit = clampLimit(params.limit);

  const identity = await findIdentity(client, params.marketplace, params.externalId);
  if (identity === null) {
    return { status: "not_found" };
  }

  const [marketplaceSnapshots, matchObservations, economicsObservations] =
    await Promise.all([
      readMarketplaceSnapshots(client, identity.id, limit),
      readMatchObservations(client, identity.id, limit),
      readEconomicsObservations(client, identity.id, limit),
    ]);

  return {
    status: "ok",
    history: {
      marketplaceProduct: {
        marketplace: identity.marketplace,
        externalId: identity.external_id,
        firstSeenAt: identity.first_seen_at,
        lastSeenAt: identity.last_seen_at,
      },
      marketplaceSnapshots,
      matchObservations,
      economicsObservations,
    },
  };
}

async function findIdentity(
  client: SupabaseClient,
  marketplace: string,
  externalId: string,
): Promise<MarketplaceProductRow | null> {
  const { data, error } = await client
    .from("marketplace_products")
    .select("*")
    .eq("marketplace", marketplace)
    .eq("external_id", externalId)
    .limit(1);

  if (error !== null || data === null || data.length === 0) {
    return null;
  }

  return data[0] as MarketplaceProductRow;
}

async function readMarketplaceSnapshots(
  client: SupabaseClient,
  marketplaceProductId: string,
  limit: number,
): Promise<ProductHistory["marketplaceSnapshots"]> {
  const { data, error } = await client
    .from("marketplace_product_snapshots")
    .select("*")
    .eq("marketplace_product_id", marketplaceProductId)
    .order("observed_at", { ascending: false })
    .limit(limit);

  if (error !== null || data === null) {
    return [];
  }

  return (data as MarketplaceSnapshotRow[]).map(marketplaceSnapshotRowToReadModel);
}

async function readMatchObservations(
  client: SupabaseClient,
  marketplaceProductId: string,
  limit: number,
): Promise<ProductHistory["matchObservations"]> {
  const { data, error } = await client
    .from("match_observations")
    .select(
      `
        supplier_product_id,
        supplier_products!inner(external_id),
        matcher_version,
        confidence,
        confidence_band,
        calculated_at
      `,
    )
    .eq("marketplace_product_id", marketplaceProductId)
    .order("calculated_at", { ascending: false })
    .limit(limit);

  if (error !== null || data === null) {
    return [];
  }

  return (data as Array<MatchHistoryJoinRow>).map((row) => ({
    supplierProductId: row.supplier_product_id,
    supplierExternalId: joinedSupplierExternalId(row.supplier_products),
    matcherVersion: row.matcher_version,
    confidence: numericToNumber(row.confidence) ?? 0,
    confidenceBand: row.confidence_band,
    calculatedAt: row.calculated_at,
  }));
}

async function readEconomicsObservations(
  client: SupabaseClient,
  marketplaceProductId: string,
  limit: number,
): Promise<ProductHistory["economicsObservations"]> {
  const { data, error } = await client
    .from("economics_observations")
    .select(
      `
        supplier_product_id,
        supplier_products!inner(external_id),
        item_price_cents,
        supplier_product_cost_cents,
        supplier_cost_basis,
        landed_cost_cents,
        marketplace_fee_cents,
        estimated_profit_cents,
        margin_percent_cents,
        completeness,
        fee_engine_version,
        calculated_at
      `,
    )
    .eq("marketplace_product_id", marketplaceProductId)
    .order("calculated_at", { ascending: false })
    .limit(limit);

  if (error !== null || data === null) {
    return [];
  }

  return (data as Array<EconomicsHistoryJoinRow>).map((row) => ({
    supplierProductId: row.supplier_product_id,
    supplierExternalId: joinedSupplierExternalId(row.supplier_products),
    itemPrice: centsToDecimalOrNull(numericToNumber(row.item_price_cents)),
    supplierProductCost: centsToDecimalOrNull(
      numericToNumber(row.supplier_product_cost_cents),
    ),
    // The column is a text enum; the value is one of the SupplierCostBasis
    // members written by the economics layer.
    supplierCostBasis: row.supplier_cost_basis as EconomicsObservationHistoryEntry["supplierCostBasis"],
    landedCost: centsToDecimalOrNull(numericToNumber(row.landed_cost_cents)),
    marketplaceFee: centsToDecimalOrNull(numericToNumber(row.marketplace_fee_cents)),
    estimatedProfit: centsToDecimalOrNull(numericToNumber(row.estimated_profit_cents)),
    marginPercent: percentCentsToMarginPercent(numericToNumber(row.margin_percent_cents)),
    completeness: row.completeness,
    feeEngineVersion: row.fee_engine_version,
    calculatedAt: row.calculated_at,
  }));
}

