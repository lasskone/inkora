/**
 * Dashboard repository — the only server-only code path the Dashboard uses to
 * read persisted intelligence (docs/ARCHITECTURE.md §13, §19).
 *
 * Deliberately *not* a domain service, exactly like the Product Detail and
 * Watchlist repositories: it reads nothing of its own, maps rows to
 * provider-identity read models, and nothing else. It never scores, never
 * matches, never prices, and never calls a marketplace, supplier or freight API.
 *
 * Conventions follow the persistence layer exactly (docs/DATABASE.md):
 *   - every function receives the client, so a test can inject a fake and no
 *     network is ever required;
 *   - every read is bounded, and most-recent-first where it is a series;
 *   - a NULL `supplier_product_id` is a *scope* (`IS NULL`), never a value;
 *   - a read failure degrades to an empty list or a `null` and the service
 *     labels the section `unavailable`, so one failing table costs only its own
 *     section (docs/ARCHITECTURE.md §19.7).
 *
 * Query design: the window read is the one access path this layer needs that did
 * not exist before, and the migration that adds its index documents why the two
 * existing history indexes cannot serve it (docs/DATABASE.md §12.6). Every other
 * read reuses an access path the watchlist, product-intelligence or seller
 * migrations already created.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { MarketplaceId } from "@/lib/marketplace/types";
import type { SupplierId } from "@/lib/supplier/types";
import { centsToDecimalOrNull, numericToNumber } from "@/lib/persistence/mapping";
import type {
  ConfidenceLevel,
  EconomicsCompleteness,
  OpportunityAssessment,
  OpportunityBand,
} from "@/lib/opportunity/types";
import type { ScopeAssessment } from "./types";

/** The only marketplace with an adapter today (docs/ARCHITECTURE.md §4). */
export const MARKETPLACE: MarketplaceId = "ebay";

/** The only supplier with an adapter today (docs/ARCHITECTURE.md §4.2). */
export const SUPPLIER: SupplierId = "cj";

/** PostgREST embeds a to-one join as an object or an array; both spellings are read. */
export function joinedExternalId(
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

/** Shape of the assessment-window read, with the identity tables joined in. */
interface AssessmentWindowRow {
  id: string;
  marketplace_product_id: string;
  supplier_product_id: string | null;
  engine_version: string;
  score: number | string;
  score_band: OpportunityBand;
  confidence: number | string;
  confidence_level: ConfidenceLevel;
  match_confidence: number | string;
  economics_completeness: EconomicsCompleteness;
  calculated_at: string;
  assessment: OpportunityAssessment | null;
  marketplace_products:
    | { external_id: string | null }
    | { external_id: string | null }[]
    | null;
  supplier_products:
    | { external_id: string | null }
    | { external_id: string | null }[]
    | null;
}

export interface AssessmentWindowRead {
  /** The mapped scope, or `null` when its reasoning document was unusable. */
  scope: ScopeAssessment | null;
  /** The internal marketplace product id, the scope key the service groups on. */
  marketplaceProductId: string;
  /** The internal supplier product id, `null` for a marketplace-only scope. */
  supplierProductId: string | null;
  /** The assessment's own time, used to order the window before grouping. */
  calculatedAt: string;
}

/**
 * Maps one persisted assessment row to the window entry the service groups on.
 *
 * Every figure comes from the row's own denormalized columns except the money,
 * the match band and the input timestamps, which the engine stores inside the
 * `assessment` document — the same split the watchlist's `assessmentRowToInfo`
 * reads. Nothing is recomputed and nothing is guessed.
 */
export function assessmentRowToWindowEntry(row: AssessmentWindowRow): AssessmentWindowRead {
  const assessment = row.assessment;
  const scope: ScopeAssessment | null =
    assessment === null || typeof assessment !== "object"
      ? // A row without its reasoning document cannot answer any question the
        // Dashboard asks, and is never silently reconstructed from summary columns.
        null
      : {
          marketplaceExternalId:
            joinedExternalId(row.marketplace_products) ?? assessment.marketplaceExternalId,
          supplierExternalId:
            row.supplier_product_id === null
              ? null
              : (joinedExternalId(row.supplier_products) ??
                assessment.supplierExternalId ??
                null),
          score: numericToNumber(row.score) ?? assessment.score,
          band: row.score_band,
          confidence: numericToNumber(row.confidence) ?? assessment.confidence,
          confidenceLevel: row.confidence_level,
          matchConfidence:
            numericToNumber(row.match_confidence) ?? assessment.components.match.confidence,
          matchConfidenceBand: assessment.components.match.confidenceBand,
          economicsCompleteness: row.economics_completeness,
          estimatedProfit: assessment.components.economics.estimatedProfit,
          marginPercent: assessment.components.economics.marginPercent,
          calculatedAt: row.calculated_at,
          engineVersion: row.engine_version,
          competitionQuery: assessment.inputs.competitionQuery ?? null,
          supplierSnapshotObservedAt: assessment.inputs.supplierSnapshotObservedAt ?? null,
          observationId: row.id,
        };

  return {
    scope,
    marketplaceProductId: row.marketplace_product_id,
    supplierProductId: row.supplier_product_id,
    calculatedAt: row.calculated_at,
  };
}

/**
 * The Dashboard's core read: the most recent assessments **across every scope**,
 * newest first, bounded by the window (docs/DATABASE.md §12.6).
 *
 * Identities come from the joined identity tables so the read model never carries
 * an internal uuid. Rows with no supplier candidate are included on purpose: an
 * assessment stored without a matcher candidate is a legitimate, fully
 * explainable verdict and a scope of its own (docs/ARCHITECTURE.md §16.2).
 */
export async function readAssessmentWindow(
  client: SupabaseClient,
  limit: number,
): Promise<AssessmentWindowRead[]> {
  const { data, error } = await client
    .from("opportunity_observations")
    .select(
      "id, marketplace_product_id, supplier_product_id, engine_version, score, score_band, confidence, confidence_level, match_confidence, economics_completeness, calculated_at, assessment, marketplace_products(external_id), supplier_products(external_id)",
    )
    .order("calculated_at", { ascending: false })
    .limit(limit);

  if (error !== null || data === null) {
    return [];
  }

  return (data as AssessmentWindowRow[]).map(assessmentRowToWindowEntry);
}

/** All persisted assessments, as an exact head count over the whole table. */
export async function countAssessments(client: SupabaseClient): Promise<number> {
  const { count, error } = await client
    .from("opportunity_observations")
    .select("id", { count: "exact", head: true });

  if (error !== null || count === null) {
    return 0;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Watchlist — monitoring intent, active entries only
// ---------------------------------------------------------------------------

/** `watchlist_entries` row with the identity tables joined. */
interface WatchlistEntryRow {
  id: string;
  marketplace_product_id: string;
  supplier_product_id: string | null;
  replay_query: string;
  label: string | null;
  created_at: string;
  updated_at: string;
  marketplace_products:
    | { external_id: string | null }
    | { external_id: string | null }[]
    | null;
  supplier_products:
    | { external_id: string | null }
    | { external_id: string | null }[]
    | null;
}

export interface DashboardWatchlistEntry {
  entryId: string;
  marketplaceExternalId: string;
  /** `null` marks a marketplace-only watch — a distinct scope, not a wildcard. */
  supplierExternalId: string | null;
  replayQuery: string;
  label: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Active entries, most recently *evaluated* first — the read behind the summary. */
export async function readActiveWatchlist(
  client: SupabaseClient,
  limit: number,
): Promise<DashboardWatchlistEntry[]> {
  const { data, error } = await client
    .from("watchlist_entries")
    .select(
      "id, marketplace_product_id, supplier_product_id, replay_query, label, created_at, updated_at, marketplace_products(external_id), supplier_products(external_id)",
    )
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error !== null || data === null) {
    return [];
  }

  return (data as WatchlistEntryRow[]).map((row) => ({
    entryId: row.id,
    marketplaceExternalId: joinedExternalId(row.marketplace_products) ?? "",
    supplierExternalId: joinedExternalId(row.supplier_products),
    replayQuery: row.replay_query,
    label: row.label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/** Active watchlist entries, exact head count over the whole table. */
export async function countActiveWatchlist(client: SupabaseClient): Promise<number> {
  const { count, error } = await client
    .from("watchlist_entries")
    .select("id", { count: "exact", head: true })
    .is("archived_at", null);

  if (error !== null || count === null) {
    return 0;
  }
  return count;
}


// ---------------------------------------------------------------------------
// Marketplace snapshots — the newest observations, and the displayed products'
// ---------------------------------------------------------------------------

/** `marketplace_product_snapshots` row for the reads this layer performs. */
interface MarketplaceSnapshotRow {
  id: string;
  marketplace_product_id: string;
  title: string;
  image_url: string | null;
  price_cents: number | string | null;
  currency: string | null;
  observed_at: string;
}

export interface MarketplaceSnapshotRead {
  /** Internal marketplace product id — the key the service joins market info on. */
  marketplaceProductId: string;
  title: string;
  imageUrl: string | null;
  /** Latest persisted price, decimal string, or `null` when the provider gave none. */
  price: string | null;
  currency: string | null;
  observedAt: string;
}

export function snapshotRowToRead(row: MarketplaceSnapshotRow): MarketplaceSnapshotRead {
  return {
    marketplaceProductId: row.marketplace_product_id,
    title: row.title,
    imageUrl: row.image_url,
    price: centsToDecimalOrNull(numericToNumber(row.price_cents)),
    currency: row.currency,
    observedAt: row.observed_at,
  };
}

/**
 * The newest marketplace observations across all listings — one bounded read that
 * serves both the recent-activity feed and the freshness panel.
 */
export async function readNewestMarketplaceSnapshots(
  client: SupabaseClient,
  limit: number,
): Promise<MarketplaceSnapshotRead[]> {
  const { data, error } = await client
    .from("marketplace_product_snapshots")
    .select("id, marketplace_product_id, title, image_url, price_cents, currency, observed_at")
    .order("observed_at", { ascending: false })
    .limit(limit);

  if (error !== null || data === null) {
    return [];
  }

  return (data as MarketplaceSnapshotRow[]).map(snapshotRowToRead);
}

/**
 * The latest snapshot per product for the products actually displayed — one
 * set-based read with `.in()`, never one read per product.
 *
 * Rows arrive newest-first, so the first row seen for a product *is* its latest
 * observation and later rows for the same product are dropped. The read is capped
 * by `DASHBOARD_SNAPSHOT_READ_CAP`; a product whose history exceeds the budget
 * renders without a title and price, which is the honest degradation — never a
 * stale or wrong value presented as current.
 */
export async function readMarketplaceSnapshotsForProducts(
  client: SupabaseClient,
  marketplaceProductIds: string[],
  limit: number,
): Promise<MarketplaceSnapshotRead[]> {
  if (marketplaceProductIds.length === 0) {
    return [];
  }

  const { data, error } = await client
    .from("marketplace_product_snapshots")
    .select("id, marketplace_product_id, title, image_url, price_cents, currency, observed_at")
    .in("marketplace_product_id", marketplaceProductIds)
    .order("observed_at", { ascending: false })
    .limit(limit);

  if (error !== null || data === null) {
    return [];
  }

  const seen = new Set<string>();
  const latest: MarketplaceSnapshotRead[] = [];
  for (const row of data as MarketplaceSnapshotRow[]) {
    if (seen.has(row.marketplace_product_id)) {
      continue;
    }
    seen.add(row.marketplace_product_id);
    latest.push(snapshotRowToRead(row));
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Seller observations — the newest observations across all sellers
// ---------------------------------------------------------------------------

/** `marketplace_seller_observations` row with the seller identity joined. */
interface SellerObservationRow {
  id: string;
  marketplace_seller_id: string;
  context_query: string;
  observed_at: string;
  marketplace_sellers:
    | { external_seller_id: string | null; username: string | null }
    | { external_seller_id: string | null; username: string | null }[]
    | null;
}

export interface SellerObservationRead {
  /** Stable provider seller handle — the identity the Seller Scanner records. */
  externalSellerId: string;
  /** Provider display spelling, informational. */
  username: string | null;
  /** The context query the observation was scoped to. */
  contextQuery: string;
  observedAt: string;
}

/**
 * The newest seller observations across all sellers — one bounded read that serves
 * the recent-activity feed and the freshness panel. Reuses the access path the
 * seller-intelligence migration created (docs/DATABASE.md §12.4).
 */
export async function readNewestSellerObservations(
  client: SupabaseClient,
  limit: number,
): Promise<SellerObservationRead[]> {
  const { data, error } = await client
    .from("marketplace_seller_observations")
    .select(
      "id, marketplace_seller_id, context_query, observed_at, marketplace_sellers(external_seller_id, username)",
    )
    .order("observed_at", { ascending: false })
    .limit(limit);

  if (error !== null || data === null) {
    return [];
  }

  return (data as SellerObservationRow[]).map((row) => {
    const seller = Array.isArray(row.marketplace_sellers)
      ? (row.marketplace_sellers[0] ?? null)
      : row.marketplace_sellers;
    return {
      externalSellerId: seller?.external_seller_id ?? "",
      username: seller?.username ?? null,
      contextQuery: row.context_query,
      observedAt: row.observed_at,
    };
  });
}
